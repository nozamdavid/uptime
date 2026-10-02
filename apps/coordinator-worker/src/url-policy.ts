import { isForbiddenIpLiteral } from '@uptime/contracts';

/**
 * Structural URL validation for monitor targets.
 *
 * Workers cannot resolve a hostname to inspect its addresses, so the probe
 * Worker remains the SSRF boundary (it rejects forbidden literals and
 * revalidates every redirect). The coordinator still validates the URL shape
 * before dispatch and drops credentials, unsupported protocols, and forbidden
 * IP literals.
 */
export function validateProbeTarget(raw: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_protocol' };
  }
  if (url.username || url.password) return { ok: false, reason: 'url_credentials' };
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isForbiddenIpLiteral(hostname)) return { ok: false, reason: 'blocked_address' };
  return { ok: true };
}
