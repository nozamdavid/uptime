/**
 * Shared SSRF guard for IP literals.
 *
 * Pure functions with no Node or Workers dependencies, so the API,
 * scheduler, and probe Worker all enforce the same blocklist.
 * Callers remain responsible for DNS resolution: pass every resolved
 * address through these checks before use.
 */

/** IPv4 ranges that must never be probed: loopback, private, CGNAT, special-use, multicast, reserved. */
export const forbiddenIpv4Cidrs = [
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

/** Parse a dotted quad into an unsigned 32-bit integer, or null when it is not one. */
export function ipv4StringToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result * 256 + octet) >>> 0;
  }
  return result;
}

function networkToInt(network: string): number {
  return network
    .split('.')
    .map(Number)
    .reduce((result, part) => (result * 256 + part) >>> 0, 0);
}

/** True when an integer IPv4 address falls inside a CIDR range. */
export function isIntInIpv4Cidr(value: number, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (networkToInt(network) & mask);
}

/** True when an integer IPv4 address falls inside any forbidden range. */
export function isIntInForbiddenIpv4Cidrs(value: number): boolean {
  return forbiddenIpv4Cidrs.some(([network, prefix]) => isIntInIpv4Cidr(value, network, prefix));
}

/** True when a dotted quad is a forbidden IPv4 literal. False for anything else. */
export function isForbiddenIpv4Literal(host: string): boolean {
  const parsed = ipv4StringToInt(host.replace(/^\[|\]$/g, '').toLowerCase());
  return parsed !== null && isIntInForbiddenIpv4Cidrs(parsed);
}

/**
 * True when a value is a forbidden IPv6 literal: unspecified, loopback,
 * unique-local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8),
 * discard (100::/64), documentation (2001:db8::/32), benchmarking
 * (2001:2::/48), or IPv4-mapped (rejected in any form). False for anything else.
 */
export function isForbiddenIpv6Literal(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized.includes(':')) return false;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8') ||
    normalized.startsWith('2001:2:') ||
    normalized.startsWith('100:') ||
    normalized.startsWith('::ffff:')
  );
}

/** True when a value is a forbidden IP literal of either family. False for hostnames. */
export function isForbiddenIpLiteral(host: string): boolean {
  return isForbiddenIpv4Literal(host) || isForbiddenIpv6Literal(host);
}
