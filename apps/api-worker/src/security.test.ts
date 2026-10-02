import { describe, expect, it } from 'vitest';

import { assertRequestOrigin, IsolateRateLimiter, corsHeaders, parseCookies } from './http.js';
import { isForbiddenIp, assertPublicHttpUrl } from './security.js';

describe('SSRF address policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.51.100.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])('blocks forbidden literal %s', (address) => expect(isForbiddenIp(address)).toBe(true));

  it.each(['1.1.1.1', '8.8.8.8', '203.1.1.1', '2606:4700:4700::1111', 'example.com'])(
    'allows public host %s',
    (address) => expect(isForbiddenIp(address)).toBe(false),
  );

  it('rejects credentials and unsupported schemes before persistence', () => {
    expect(() => assertPublicHttpUrl('https://user:pass@example.com')).toThrow('credentials');
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow('HTTP');
    expect(() => assertPublicHttpUrl('http://127.0.0.1')).toThrow('private');
    expect(() => assertPublicHttpUrl('not a url')).toThrow('valid absolute');
  });
});

describe('origin enforcement', () => {
  it('allows unsafe requests without an origin header', () => {
    expect(() =>
      assertRequestOrigin(new Request('https://api.test/api/monitors', { method: 'POST' }), []),
    ).not.toThrow();
  });

  it('requires a configured origin to match exactly', () => {
    const request = new Request('https://api.test/api/monitors', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(() => assertRequestOrigin(request, ['https://app.example'])).toThrow('not allowed');
  });

  it('allows a matching configured origin', () => {
    const request = new Request('https://api.test/api/monitors', {
      method: 'POST',
      headers: { origin: 'https://app.example' },
    });
    expect(() => assertRequestOrigin(request, ['https://app.example'])).not.toThrow();
  });

  it('falls back to same-origin when no allowlist is configured', () => {
    const same = new Request('https://api.test/api/monitors', {
      method: 'POST',
      headers: { origin: 'https://api.test' },
    });
    expect(() => assertRequestOrigin(same, [])).not.toThrow();
    const cross = new Request('https://api.test/api/monitors', {
      method: 'POST',
      headers: { origin: 'https://other.test' },
    });
    expect(() => assertRequestOrigin(cross, [])).toThrow('not allowed');
  });

  it('never blocks safe GET requests', () => {
    const request = new Request('https://api.test/api/monitors', {
      headers: { origin: 'https://evil.example' },
    });
    expect(() => assertRequestOrigin(request, ['https://app.example'])).not.toThrow();
  });
});

describe('CORS', () => {
  it('only echoes allow-listed origins with credentials', () => {
    const request = new Request('https://api.test/api/regions', {
      headers: { origin: 'https://app.example' },
    });
    expect(corsHeaders(request, ['https://app.example'])).toMatchObject({
      'access-control-allow-origin': 'https://app.example',
      'access-control-allow-credentials': 'true',
    });
    expect(corsHeaders(request, ['https://other.example'])).toEqual({});
  });
});

describe('rate limiter', () => {
  it('enforces a fixed window per key', () => {
    const limiter = new IsolateRateLimiter();
    const rule = { max: 2, windowSeconds: 60 };
    expect(limiter.check('a', rule, 0)).toBe(true);
    expect(limiter.check('a', rule, 1)).toBe(true);
    expect(limiter.check('a', rule, 2)).toBe(false);
    expect(limiter.check('b', rule, 2)).toBe(true);
    expect(limiter.check('a', rule, 61_000)).toBe(true);
  });
});

describe('cookie parsing', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; uptime_session=abc%20def')).toEqual({
      a: '1',
      uptime_session: 'abc def',
    });
    expect(parseCookies(null)).toEqual({});
  });

  it('does not throw on a malformed percent-encoded cookie value', () => {
    expect(() => parseCookies('uptime_session=%')).not.toThrow();
    expect(parseCookies('uptime_session=%')).toEqual({ uptime_session: '%' });
  });
});
