import { describe, expect, it } from 'vitest';

import { validateProbeTarget } from './url-policy.js';

describe('probe target policy', () => {
  it('accepts ordinary public HTTP(S) URLs', () => {
    expect(validateProbeTarget('https://example.com/health')).toEqual({ ok: true });
    expect(validateProbeTarget('http://example.com')).toEqual({ ok: true });
  });

  it('rejects unsupported protocols, credentials, and forbidden literals', () => {
    expect(validateProbeTarget('ftp://example.com')).toMatchObject({
      ok: false,
      reason: 'invalid_protocol',
    });
    expect(validateProbeTarget('https://user:pass@example.com')).toMatchObject({
      ok: false,
      reason: 'url_credentials',
    });
    expect(validateProbeTarget('http://127.0.0.1:8080')).toMatchObject({
      ok: false,
      reason: 'blocked_address',
    });
    expect(validateProbeTarget('http://10.0.0.5')).toMatchObject({ ok: false });
    expect(validateProbeTarget('http://[::1]/')).toMatchObject({ ok: false });
    expect(validateProbeTarget('not a url')).toMatchObject({ ok: false, reason: 'invalid_url' });
  });
});
