import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** URL policy shared in spirit with probes; probe validation remains authoritative. */
export function assertPublicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UrlPolicyError('invalid_url', 'A valid absolute HTTP(S) URL is required');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlPolicyError('invalid_scheme', 'URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new UrlPolicyError('url_credentials', 'URLs with embedded credentials are not allowed');
  }
  if (!url.hostname) {
    throw new UrlPolicyError('invalid_url', 'URL must include a hostname');
  }
  if (isForbiddenIp(url.hostname)) {
    throw new UrlPolicyError('forbidden_address', 'URL resolves to a private or reserved address');
  }
  return url;
}

export async function assertResolvablePublicHttpUrl(value: string): Promise<URL> {
  const url = assertPublicHttpUrl(value);
  if (isIP(url.hostname)) return url;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new UrlPolicyError('dns_unresolved', 'URL hostname could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isForbiddenIp(address))) {
    throw new UrlPolicyError('forbidden_address', 'URL resolves to a private or reserved address');
  }
  return url;
}

export class UrlPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Rejects loopback, link-local, private, CGNAT, documentation, multicast, and reserved ranges. */
export function isForbiddenIp(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(normalized);
  if (kind === 4) {
    const parts = normalized.split('.').map(Number);
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    )
      return true;
    const value = parts.reduce((result, part) => (result * 256 + part) >>> 0, 0);
    return forbiddenIpv4Cidrs.some(([network, prefix]) => inIpv4Cidr(value, network, prefix));
  }
  if (kind === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8') ||
      normalized.startsWith('2001:2:') ||
      normalized.startsWith('100:') ||
      // IPv4-mapped forms can encode a private IPv4 in hexadecimal. The public
      // use case has no reason to use this representation, so reject all of it.
      normalized.startsWith('::ffff:')
    );
  }
  return false;
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
