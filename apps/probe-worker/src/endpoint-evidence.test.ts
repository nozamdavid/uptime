import { describe, expect, it } from 'vitest';

import { collectEndpointEvidence } from './endpoint-evidence.js';

describe('collectEndpointEvidence', () => {
  it.each([
    ['https://direct.example/path', 'direct.example'],
    ['https://final.example/after-redirect', 'final.example'],
  ])('normalizes the final hostname from %s', (url, hostname) => {
    expect(collectEndpointEvidence(url, new Headers())?.finalHostname).toBe(hostname);
  });

  it.each([
    ['cf-ray', '8f1234567890abcd-LHR', 'cloudflare', 'LHR', 'europe'],
    ['x-amz-cf-pop', 'IAD89-P2', 'cloudfront', 'IAD89', 'north_america'],
    ['x-served-by', 'cache-sin-wsss1830034-SIN', 'fastly', 'SIN', 'asia'],
    ['x-vercel-id', 'syd1::iad1::abc', 'vercel', 'syd1', 'oceania'],
  ] as const)('parses provider evidence from %s', (name, value, provider, edge, continent) => {
    const evidence = collectEndpointEvidence('https://example.com', new Headers({ [name]: value }));
    expect(evidence?.primaryCdn).toMatchObject({
      provider,
      reportedEdge: edge,
      inferredContinent: continent,
      confidence: 'provider_reported',
      evidenceHeader: name,
      parserVersion: '1',
    });
  });

  it('maps a representative unknown POP to no continent', () => {
    const evidence = collectEndpointEvidence(
      'https://example.com',
      new Headers({ 'cf-ray': '8f1234567890abcd-ZZZ' }),
    );
    expect(evidence?.primaryCdn).toMatchObject({ reportedEdge: 'ZZZ', inferredContinent: null });
  });

  it('retains only allowlisted, printable, bounded signals', () => {
    const headers = new Headers({
      authorization: 'Bearer secret',
      'set-cookie': 'session=secret',
      'x-amz-cf-id': 'request-correlation-id-that-is-not-needed-for-pop-detection',
      server: 'x'.repeat(700),
      'x-application-trace': 'private',
    });
    const evidence = collectEndpointEvidence('https://example.com', headers);
    expect(evidence?.signals).toEqual([{ name: 'server', value: 'x'.repeat(512) }]);
  });

  it('normalizes control characters before applying the byte-safe ASCII bound', () => {
    const headers = {
      get(name: string) {
        return name === 'server' ? `edge\u0000\u0009${'é'.repeat(600)}tail` : null;
      },
    } as unknown as Headers;
    const value = collectEndpointEvidence('https://example.com', headers)?.signals[0]?.value;
    expect(value).toMatch(/^[\x20-\x7e]+$/);
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(512);
  });

  it('does not infer a provider from weak or spoof-like values', () => {
    const evidence = collectEndpointEvidence(
      'https://example.com',
      new Headers({ server: 'cloudflare', 'cf-ray': 'made-up', via: '1.1 varnish' }),
    );
    expect(evidence?.primaryCdn).toBeNull();
    expect(evidence?.signals).toHaveLength(3);
  });

  it('preserves multi-hop Fastly evidence without choosing an edge', () => {
    const raw = 'cache-iad-kjyo7100042-IAD, cache-lhr-egll1980021-LHR';
    const evidence = collectEndpointEvidence(
      'https://example.com',
      new Headers({ 'x-served-by': raw }),
    );
    expect(evidence?.signals).toEqual([{ name: 'x-served-by', value: raw }]);
    expect(evidence?.primaryCdn).toBeNull();
  });

  it('keeps conflicting providers as raw evidence without selecting a primary', () => {
    const evidence = collectEndpointEvidence(
      'https://example.com',
      new Headers({ 'cf-ray': '8f1234567890abcd-LHR', 'x-amz-cf-pop': 'DUB2-C1' }),
    );
    expect(evidence?.signals).toHaveLength(2);
    expect(evidence?.primaryCdn).toBeNull();
  });

  it('returns hostname-only evidence when there are no headers', () => {
    expect(collectEndpointEvidence('https://example.com', new Headers())).toEqual({
      finalHostname: 'example.com',
      signals: [],
      primaryCdn: null,
    });
  });

  it('contains header collection failures', () => {
    const throwingHeaders = {
      get() {
        throw new Error('header adapter failed');
      },
    } as unknown as Headers;
    expect(collectEndpointEvidence('https://example.com', throwingHeaders)).toEqual({
      finalHostname: 'example.com',
      signals: [],
      primaryCdn: null,
    });
  });
});
