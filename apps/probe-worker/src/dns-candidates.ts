import type {
  DnsCandidate,
  DnsDiagnosticInstruction,
  DnsDiagnosticResult,
} from '@uptime/contracts';

const answerCap = 8;
const maxTtlSeconds = 604_800;
const maxDohResponseBytes = 32_768;

type DnsRecordType = 'A' | 'AAAA' | 'CNAME';

export interface ResolverAnswer {
  readonly type: DnsRecordType;
  readonly data: string;
  readonly ttl: number;
}

/** Internal seam used by the Cloudflare DoH adapter and deterministic tests. */
export interface DnsResolverAdapter {
  resolve(
    hostname: string,
    type: DnsRecordType,
    signal: AbortSignal,
  ): Promise<readonly ResolverAnswer[]>;
}

interface DnsJsonAnswer {
  readonly type?: unknown;
  readonly TTL?: unknown;
  readonly data?: unknown;
}

interface DnsJsonResponse {
  readonly Status?: unknown;
  readonly Question?: unknown;
  readonly Answer?: unknown;
}

interface DnsJsonQuestion {
  readonly name?: unknown;
  readonly type?: unknown;
}

const recordNumberByType: Readonly<Record<DnsRecordType, number>> = {
  A: 1,
  CNAME: 5,
  AAAA: 28,
};

export const cloudflareDohResolver: DnsResolverAdapter = {
  async resolve(hostname, type, signal) {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal,
    });
    if (!response.ok) throw new Error('resolver_failure');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    if (contentType !== 'application/dns-json') {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('resolver_failure');
    }
    const payload = parseBoundedDnsJson(await readBoundedBody(response, maxDohResponseBytes));
    if (!questionMatches(payload.Question, hostname, recordNumberByType[type])) {
      throw new Error('resolver_failure');
    }
    // NXDOMAIN and NODATA are honest, empty candidate sets rather than failures.
    if (payload.Status === 3) return [];
    if (payload.Status !== 0 || (payload.Answer !== undefined && !Array.isArray(payload.Answer))) {
      throw new Error('resolver_failure');
    }
    const answers = (payload.Answer ?? []) as DnsJsonAnswer[];
    return answers.slice(0, 64).flatMap((answer): ResolverAnswer[] => {
      if (
        answer.type !== recordNumberByType[type] ||
        typeof answer.data !== 'string' ||
        typeof answer.TTL !== 'number' ||
        !Number.isFinite(answer.TTL)
      ) {
        return [];
      }
      return [{ type, data: answer.data, ttl: answer.TTL }];
    });
  },
};

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('resolver_failure');
  }
  if (!response.body) throw new Error('resolver_failure');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('resolver_failure');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseBoundedDnsJson(text: string): DnsJsonResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('resolver_failure');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('resolver_failure');
  }
  return value as DnsJsonResponse;
}

function questionMatches(value: unknown, hostname: string, type: number): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const question = value[0] as DnsJsonQuestion;
  if (question === null || typeof question !== 'object') return false;
  return normalizeHostname(String(question.name ?? '')) === hostname && question.type === type;
}

interface CollectionDependencies {
  readonly resolver?: DnsResolverAdapter;
  readonly now?: () => Date;
}

function normalizeHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253) return null;
  const labels = hostname.split('.');
  if (
    labels.some(
      (label) =>
        label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }
  return hostname;
}

function ipv4Number(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return null;
  return octets.reduce((result, part) => (result * 256 + part) >>> 0, 0);
}

function inIpv4Cidr(value: number, network: string, prefix: number): boolean {
  const networkValue = ipv4Number(network)!;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (networkValue & mask);
}

const specialIpv4Cidrs = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

function classifyIpv4(value: string): 'public' | 'special' | 'invalid' {
  const parsed = ipv4Number(value);
  if (parsed === null) return 'invalid';
  return specialIpv4Cidrs.some(([network, prefix]) => inIpv4Cidr(parsed, network, prefix))
    ? 'special'
    : 'public';
}

function ipv6Number(value: string): bigint | null {
  const input = value.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(input) || input.includes(':::')) return null;
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function inIpv6Cidr(value: bigint, network: string, prefix: number): boolean {
  const networkValue = ipv6Number(network)!;
  const shift = BigInt(128 - prefix);
  return value >> shift === networkValue >> shift;
}

const specialIpv6Cidrs = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  // IETF protocol assignments, 6to4, and documentation ranges are not
  // useful public origin candidates. Reject the entire blocks conservatively.
  ['2001::', 23],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2001:10::', 28],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const;

function classifyIpv6(value: string): 'public' | 'special' | 'invalid' {
  const parsed = ipv6Number(value);
  if (parsed === null) return 'invalid';
  if (
    !inIpv6Cidr(parsed, '2000::', 3) ||
    specialIpv6Cidrs.some(([network, prefix]) => inIpv6Cidr(parsed, network, prefix))
  ) {
    return 'special';
  }
  return 'public';
}

function boundedTtl(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.trunc(value), maxTtlSeconds);
}

/**
 * Collects a bounded snapshot of DNS candidates for the already-validated final
 * HTTP hostname. It is non-throwing and never claims a candidate was connected.
 */
export async function collectDnsCandidates(
  finalHostname: string,
  instruction: DnsDiagnosticInstruction,
  dependencies: CollectionDependencies = {},
): Promise<DnsDiagnosticResult> {
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const hostname = normalizeHostname(finalHostname);
  const base = {
    diagnosticId: instruction.diagnosticId,
    windowStartedAt: instruction.windowStartedAt,
    finalHostname: hostname ?? finalHostname.slice(0, 253),
    resolver: 'cloudflare-doh' as const,
    observedAt,
    cnameCandidates: [] as string[],
    aCandidates: [] as DnsCandidate[],
    aaaaCandidates: [] as DnsCandidate[],
    filteredAddressCount: 0,
    schemaVersion: '1' as const,
    parserVersion: '1' as const,
  };
  if (!hostname) return { ...base, status: 'failed', errorCode: 'invalid_hostname' };

  const resolver = dependencies.resolver ?? cloudflareDohResolver;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(100, Math.min(instruction.deadlineMs, 2_000)),
  );
  try {
    const results = await Promise.allSettled(
      (['CNAME', 'A', 'AAAA'] as const).map(async (type) => ({
        type,
        answers: await resolver.resolve(hostname, type, controller.signal),
      })),
    );
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    const cnames = new Set<string>();
    const ipv4 = new Map<string, DnsCandidate>();
    const ipv6 = new Map<string, DnsCandidate>();
    let filteredAddressCount = 0;

    for (const settled of results) {
      if (settled.status === 'rejected') continue;
      for (const answer of settled.value.answers) {
        if (answer.type === 'CNAME') {
          const candidate = normalizeHostname(answer.data);
          if (candidate) cnames.add(candidate);
          continue;
        }
        const ttl = boundedTtl(answer.ttl);
        if (ttl === null) continue;
        if (answer.type === 'A') {
          const classification = classifyIpv4(answer.data);
          if (classification === 'invalid') continue;
          if (classification === 'special') {
            filteredAddressCount += 1;
            continue;
          }
          if (!ipv4.has(answer.data)) ipv4.set(answer.data, { address: answer.data, ttl });
        } else if (answer.type === 'AAAA') {
          const normalized = answer.data.toLowerCase();
          const classification = classifyIpv6(normalized);
          if (classification === 'invalid') continue;
          if (classification === 'special') {
            filteredAddressCount += 1;
            continue;
          }
          if (!ipv6.has(normalized)) ipv6.set(normalized, { address: normalized, ttl });
        }
      }
    }

    const timedOut = controller.signal.aborted;
    return {
      ...base,
      status: failedCount === 0 ? 'success' : failedCount === 3 ? 'failed' : 'partial',
      cnameCandidates: [...cnames].slice(0, answerCap),
      aCandidates: [...ipv4.values()].slice(0, answerCap),
      aaaaCandidates: [...ipv6.values()].slice(0, answerCap),
      filteredAddressCount,
      errorCode: failedCount === 0 ? null : timedOut ? 'timeout' : 'resolver_failure',
    };
  } catch {
    return {
      ...base,
      status: 'failed',
      errorCode: controller.signal.aborted ? 'timeout' : 'resolver_failure',
    };
  } finally {
    clearTimeout(timeout);
  }
}
