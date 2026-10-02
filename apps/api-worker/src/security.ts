import {
  isForbiddenIpLiteral,
  isIntInForbiddenIpv4Cidrs,
  ipv4StringToInt,
} from '@uptime/contracts';

/**
 * Pre-save URL policy for public monitoring targets.
 *
 * Syntax, protocol, embedded credentials, and IP-literal blocklists are
 * enforced before save. The probe revalidates redirects and literal hosts;
 * DNS names are not resolved and pinned to a public destination IP here.
 */
export class UrlPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

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

/** Async entry point used by monitor validation. */
export async function assertResolvablePublicHttpUrl(value: string): Promise<URL> {
  return assertPublicHttpUrl(value);
}

export function isForbiddenIp(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.includes(':')) return isForbiddenIpLiteral(normalized);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const parsed = ipv4StringToInt(normalized);
    return parsed === null || isIntInForbiddenIpv4Cidrs(parsed);
  }
  return false;
}
