import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Observation } from '@uptime/contracts';
import {
  EndpointEvidence,
  summarizeEndpointEvidence,
  truncateEndpointValue,
} from './endpoint-evidence.js';

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    checkRunId: '00000000-0000-4000-8000-000000000002',
    monitorId: '00000000-0000-4000-8000-000000000003',
    regionId: 'eu-west',
    status: 'success',
    success: true,
    httpStatus: 200,
    responseMs: 120,
    totalMs: 150,
    errorCode: null,
    errorDetail: null,
    placement: 'aws:eu-west-1',
    colo: 'DUB',
    finalUrl: 'https://www.example.com/health?check=1',
    endpointEvidence: null,
    dnsDiagnostic: null,
    redirectCount: 0,
    bodyBytes: 42,
    probeVersion: '1',
    startedAt: '2026-08-30T10:00:00.000Z',
    completedAt: '2026-08-30T10:00:00.150Z',
    ...overrides,
  };
}

describe('endpoint evidence presentation data', () => {
  it('summarizes Cloudflare evidence without treating it as a connected endpoint', () => {
    const result = summarizeEndpointEvidence(
      observation({
        endpointEvidence: {
          finalHostname: 'www.example.com',
          signals: [
            { name: 'cf-ray', value: 'abc123-LHR' },
            { name: 'cf-cache-status', value: 'HIT' },
          ],
          primaryCdn: {
            provider: 'cloudflare',
            reportedEdge: 'LHR',
            inferredContinent: 'europe',
            confidence: 'provider_reported',
            evidenceHeader: 'cf-ray',
            parserVersion: '1',
          },
        },
      }),
    );

    expect(result).toMatchObject({
      finalUrl: 'https://www.example.com/health?check=1',
      finalHostname: 'www.example.com',
      provider: 'Cloudflare',
      reportedEdge: 'LHR',
      inferredContinent: 'Europe',
      evidenceHeader: 'cf-ray',
      parserVersion: '1',
    });
    expect(result.signals).toHaveLength(2);
  });

  it('summarizes CloudFront evidence and keeps an unknown continent explicit', () => {
    const result = summarizeEndpointEvidence(
      observation({
        endpointEvidence: {
          finalHostname: 'd111111abcdef8.cloudfront.net',
          signals: [{ name: 'x-amz-cf-pop', value: 'ZZZ1-P1' }],
          primaryCdn: {
            provider: 'cloudfront',
            reportedEdge: 'ZZZ1-P1',
            inferredContinent: null,
            confidence: 'provider_reported',
            evidenceHeader: 'x-amz-cf-pop',
            parserVersion: '1',
          },
        },
      }),
    );

    expect(result.provider).toBe('CloudFront');
    expect(result.reportedEdge).toBe('ZZZ1-P1');
    expect(result.inferredContinent).toBeNull();
  });

  it('handles legacy or failed observations without endpoint evidence', () => {
    expect(summarizeEndpointEvidence(observation({ endpointEvidence: null }))).toMatchObject({
      finalUrl: 'https://www.example.com/health?check=1',
      finalHostname: 'www.example.com',
      provider: null,
      signals: [],
    });
    expect(
      summarizeEndpointEvidence(observation({ finalUrl: null, endpointEvidence: null })),
    ).toMatchObject({ finalUrl: null, finalHostname: null, provider: null });
  });

  it('truncates long values for display while retaining the full value for copy', () => {
    const longValue = 'x'.repeat(512);
    const display = truncateEndpointValue(longValue);
    expect(display).toHaveLength(120);
    expect(display.endsWith('…')).toBe(true);
    expect(display).not.toBe(longValue);
  });

  it('renders provider-reported and legacy-null states without interpreting signal markup', () => {
    const reported = renderToStaticMarkup(
      createElement(EndpointEvidence, {
        item: observation({
          endpointEvidence: {
            finalHostname: 'www.example.com',
            signals: [{ name: 'server', value: '<script>alert(1)</script>' }],
            primaryCdn: {
              provider: 'cloudflare',
              reportedEdge: 'LHR',
              inferredContinent: 'europe',
              confidence: 'provider_reported',
              evidenceHeader: 'cf-ray',
              parserVersion: '1',
            },
          },
        }),
      }),
    );
    expect(reported).toContain('Provider-reported');
    expect(reported).toContain('Inferred continent: Europe');
    expect(reported).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(reported).not.toContain('<script>');

    const legacy = renderToStaticMarkup(
      createElement(EndpointEvidence, {
        item: observation({ finalUrl: null, endpointEvidence: null }),
      }),
    );
    expect(legacy).toContain('No CDN evidence reported');
    expect(legacy).toContain('Final URL unknown');
  });
});
