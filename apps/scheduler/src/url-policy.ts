import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Re-resolve immediately before dispatch so a hostname changed after monitor creation is blocked. */
export async function assertCurrentlyPublicTarget(raw: string): Promise<void> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Target URL is no longer an allowed HTTP(S) destination');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [hostname]
    : (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
    throw new Error('Target hostname currently resolves to a private or reserved address');
  }
}

function isForbiddenAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized) === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('::ffff:') ||
      normalized.startsWith('100:') ||
      normalized.startsWith('2001:2:') ||
      normalized.startsWith('2001:db8:')
    );
  }
  if (isIP(normalized) !== 4) return true;
  const value = normalized
    .split('.')
    .map(Number)
    .reduce((sum, part) => (sum * 256 + part) >>> 0, 0);
  return forbiddenIpv4Cidrs.some(([network, prefix]) => inCidr(value, network, prefix));
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

function inCidr(value: number, network: string, prefix: number): boolean {
  const networkValue = network
    .split('.')
    .map(Number)
    .reduce((sum, part) => (sum * 256 + part) >>> 0, 0);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (networkValue & mask);
}
