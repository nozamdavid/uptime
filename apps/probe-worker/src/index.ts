import {
  probeRequestSchema,
  type ObservationErrorCode,
  type ProbeRequest,
  type ProbeResponse,
} from '@uptime/contracts';
import { isRegionId, type RegionId } from '@uptime/regions';

import { collectEndpointEvidence } from './endpoint-evidence.js';
import { collectDnsCandidates } from './dns-candidates.js';

interface Env {
  PROBE_REGION: RegionId;
  PROBE_SIGNING_SECRET: string;
  PROBE_REQUEST_MAX_SKEW_SECONDS: string;
  PROBE_MAX_REQUEST_BYTES: string;
  PROBE_VERSION: string;
}

const maxRedirects = 5;
const maxBodyBytes = 65_536;
const signatureVersion = 'v1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function errorResponse(code: string, status: number): Response {
  return json({ error: { code } }, status);
}

function isForbiddenIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((value) => value > 255)) return true;
  const value = octets.reduce((result, part) => (result * 256 + part) >>> 0, 0);
  return forbiddenIpv4Cidrs.some(([network, prefix]) => inIpv4Cidr(value, network, prefix));
}

const forbiddenIpv4Cidrs = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

function inIpv4Cidr(value: number, network: string, prefix: number): boolean {
  const networkValue = network
    .split('.')
    .map(Number)
    .reduce((result, part) => (result * 256 + part) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (networkValue & mask);
}

function isForbiddenIpv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized.includes(':')) return false;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('2001:2:') ||
    normalized.startsWith('100:') ||
    normalized.startsWith('::ffff:')
  );
}

function validateTarget(raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error('invalid_url');
  }
  if (
    (target.protocol !== 'http:' && target.protocol !== 'https:') ||
    target.username ||
    target.password ||
    (target.port && !/^\d+$/.test(target.port))
  ) {
    throw new Error('invalid_url');
  }
  if (isForbiddenIpv4(target.hostname) || isForbiddenIpv6(target.hostname))
    throw new Error('blocked_address');
  return target;
}

async function expectedSignature(
  secret: string,
  issuedAt: string,
  requestId: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = encoder.encode(`${signatureVersion}\n${issuedAt}\n${requestId}\n${body}`);
  const signature = await crypto.subtle.sign('HMAC', key, data);
  const bytes = new Uint8Array(signature);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function consumeBounded(
  response: Response,
  limit: number,
): Promise<{ bodyBytes: number; exceeded: boolean }> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    return { bodyBytes: 0, exceeded: true };
  }
  if (!response.body) return { bodyBytes: 0, exceeded: false };
  const reader = response.body.getReader();
  let total = 0;
  let exceeded = false;
  try {
    while (total <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        exceeded = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { bodyBytes: Math.min(total, limit), exceeded };
}

function result(request: ProbeRequest, fields: Omit<ProbeResponse, 'regionId'>): ProbeResponse {
  return { regionId: request.regionId, ...fields };
}

function failure(
  request: ProbeRequest,
  errorCode: ObservationErrorCode,
  detail: string,
  startedAt: string,
  env: Env,
  metadata: Partial<
    Pick<
      ProbeResponse,
      | 'responseMs'
      | 'totalMs'
      | 'placement'
      | 'colo'
      | 'finalUrl'
      | 'endpointEvidence'
      | 'dnsDiagnostic'
      | 'redirectCount'
      | 'bodyBytes'
    >
  > = {},
): ProbeResponse {
  return result(request, {
    status: 'network_failure',
    success: false,
    httpStatus: null,
    responseMs: metadata.responseMs ?? null,
    totalMs: metadata.totalMs ?? null,
    errorCode,
    errorDetail: detail.slice(0, 500),
    placement: metadata.placement ?? null,
    colo: metadata.colo ?? null,
    finalUrl: metadata.finalUrl ?? null,
    endpointEvidence: metadata.endpointEvidence ?? null,
    dnsDiagnostic: metadata.dnsDiagnostic ?? null,
    redirectCount: metadata.redirectCount ?? null,
    bodyBytes: metadata.bodyBytes ?? null,
    probeVersion: env.PROBE_VERSION,
    startedAt,
    completedAt: new Date().toISOString(),
  });
}

async function diagnosticFor(request: ProbeRequest, target: URL) {
  if (!request.dnsDiagnostic) return null;
  return collectDnsCandidates(target.hostname, request.dnsDiagnostic);
}

async function probe(
  request: ProbeRequest,
  env: Env,
  runtime: { readonly colo?: string | undefined; readonly placement?: string | undefined },
): Promise<ProbeResponse> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  let target: URL;
  try {
    target = validateTarget(request.url);
  } catch (error) {
    return failure(request, 'invalid_response', String(error), startedAt, env);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  let redirects = 0;
  let responseMs: number | null = null;
  try {
    while (true) {
      const response = await fetch(target.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        cf: { cacheTtl: 0 },
      });
      responseMs = Date.now() - started;
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (redirects >= maxRedirects)
          return failure(request, 'redirect_limit', 'Maximum redirects exceeded', startedAt, env, {
            responseMs,
            totalMs: Date.now() - started,
            placement: runtime.placement ?? null,
            colo: runtime.colo ?? null,
            finalUrl: target.toString(),
            endpointEvidence: collectEndpointEvidence(target.toString(), new Headers()),
            dnsDiagnostic: await diagnosticFor(request, target),
            redirectCount: redirects,
          });
        redirects += 1;
        target = validateTarget(new URL(response.headers.get('location')!, target).toString());
        continue;
      }
      const evidenceStarted = Date.now();
      const endpointEvidence = collectEndpointEvidence(target.toString(), response.headers);
      const evidenceElapsedMs = Date.now() - evidenceStarted;
      const consumed = await consumeBounded(response, maxBodyBytes);
      if (consumed.exceeded) {
        const totalMs = Math.max(0, Date.now() - started - evidenceElapsedMs);
        const dnsDiagnostic = await diagnosticFor(request, target);
        return failure(
          request,
          'response_too_large',
          'Response body exceeded 65536 bytes',
          startedAt,
          env,
          {
            responseMs,
            totalMs,
            placement: runtime.placement ?? null,
            colo: runtime.colo ?? null,
            finalUrl: target.toString(),
            endpointEvidence,
            dnsDiagnostic,
            redirectCount: redirects,
            bodyBytes: consumed.bodyBytes,
          },
        );
      }
      const success = response.status >= 200 && response.status <= 399;
      const totalMs = Math.max(0, Date.now() - started - evidenceElapsedMs);
      const dnsDiagnostic = await diagnosticFor(request, target);
      return result(request, {
        status: success ? 'success' : 'http_failure',
        success,
        httpStatus: response.status,
        responseMs,
        totalMs,
        errorCode: null,
        errorDetail: success ? null : `HTTP ${response.status}`,
        placement: runtime.placement ?? null,
        colo: runtime.colo ?? null,
        finalUrl: target.toString(),
        endpointEvidence,
        dnsDiagnostic,
        redirectCount: redirects,
        bodyBytes: consumed.bodyBytes,
        probeVersion: env.PROBE_VERSION,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: ObservationErrorCode = controller.signal.aborted
      ? 'timeout'
      : /certificate|tls/i.test(message)
        ? 'tls'
        : 'connection';
    const totalMs = Date.now() - started;
    const dnsDiagnostic = await diagnosticFor(request, target);
    return failure(request, code, message, startedAt, env, {
      responseMs,
      totalMs,
      placement: runtime.placement ?? null,
      colo: runtime.colo ?? null,
      finalUrl: target.toString(),
      endpointEvidence: collectEndpointEvidence(target.toString(), new Headers()),
      dnsDiagnostic,
      redirectCount: redirects,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);
    const length = Number(request.headers.get('content-length') ?? 0);
    const limit = Number(env.PROBE_MAX_REQUEST_BYTES || maxBodyBytes);
    if (!Number.isFinite(length) || length > limit) return errorResponse('payload_too_large', 413);
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > limit)
      return errorResponse('payload_too_large', 413);
    const issuedAt = request.headers.get('x-uptime-issued-at');
    const requestId = request.headers.get('x-uptime-request-id');
    const signature = request.headers.get('x-uptime-signature');
    if (
      request.headers.get('x-uptime-signature-version') !== signatureVersion ||
      !issuedAt ||
      !requestId ||
      !signature
    )
      return errorResponse('invalid_signature', 401);
    const issuedAtMs = Date.parse(issuedAt);
    const skewMs = Number(env.PROBE_REQUEST_MAX_SKEW_SECONDS) * 1_000;
    if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > skewMs)
      return errorResponse('stale_request', 401);
    const expected = await expectedSignature(env.PROBE_SIGNING_SECRET, issuedAt, requestId, body);
    if (!constantTimeEqual(expected, signature)) return errorResponse('invalid_signature', 401);
    let payload: ProbeRequest;
    try {
      payload = probeRequestSchema.parse(JSON.parse(body));
    } catch {
      return errorResponse('invalid_payload', 400);
    }
    if (
      !isRegionId(env.PROBE_REGION) ||
      payload.requestId !== requestId ||
      payload.issuedAt !== issuedAt ||
      payload.regionId !== env.PROBE_REGION
    )
      return errorResponse('region_or_identity_mismatch', 403);
    const response = await probe(payload, env, {
      colo: (request.cf as unknown as { readonly colo?: string } | undefined)?.colo,
      placement: request.headers.get('cf-placement') ?? undefined,
    });
    context.waitUntil(Promise.resolve());
    return json(response);
  },
} satisfies ExportedHandler<Env>;

/* Workers cannot expose DNS lookup results or the socket destination. Literal IPs and every redirect are rejected locally;
 * hostname-to-private-IP rebinding must also be controlled through account egress/network policy and trusted targets. */
