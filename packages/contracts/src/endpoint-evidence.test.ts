import { describe, expect, it } from 'vitest';

import { endpointEvidenceSchema, observationSchema, probeResponseSchema } from './index.js';

describe('endpoint evidence contracts', () => {
  it('accepts bounded observed signals and a separate parsed result', () => {
    expect(
      endpointEvidenceSchema.parse({
        finalHostname: 'cdn.example.com',
        signals: [{ name: 'cf-ray', value: 'abc123-LHR' }],
        primaryCdn: {
          provider: 'cloudflare',
          reportedEdge: 'LHR',
          inferredContinent: 'europe',
          confidence: 'provider_reported',
          evidenceHeader: 'cf-ray',
          parserVersion: '1',
        },
      }),
    ).toBeTruthy();
  });

  it('rejects arbitrary, non-printable, and oversized signal values', () => {
    const base = { finalHostname: 'example.com', primaryCdn: null };
    expect(() =>
      endpointEvidenceSchema.parse({ ...base, signals: [{ name: 'set-cookie', value: 'secret' }] }),
    ).toThrow();
    expect(() =>
      endpointEvidenceSchema.parse({ ...base, signals: [{ name: 'server', value: 'bad\nvalue' }] }),
    ).toThrow();
    expect(() =>
      endpointEvidenceSchema.parse({
        ...base,
        signals: [{ name: 'server', value: 'x'.repeat(513) }],
      }),
    ).toThrow();
  });

  it('requires endpointEvidence on observations while allowing null', () => {
    expect(observationSchema.shape.endpointEvidence.parse(null)).toBeNull();
  });

  it('rejects duplicate signal names', () => {
    expect(() =>
      endpointEvidenceSchema.parse({
        finalHostname: 'example.com',
        signals: [
          { name: 'server', value: 'one' },
          { name: 'server', value: 'two' },
        ],
        primaryCdn: null,
      }),
    ).toThrow();
  });

  it('rejects probe evidence whose hostname disagrees with the final URL', () => {
    expect(() =>
      probeResponseSchema.parse({
        regionId: 'eu-west',
        status: 'success',
        success: true,
        httpStatus: 200,
        responseMs: 10,
        totalMs: 12,
        errorCode: null,
        errorDetail: null,
        placement: 'aws:eu-west-1',
        colo: 'LHR',
        finalUrl: 'https://final.example/path',
        endpointEvidence: {
          finalHostname: 'other.example',
          signals: [],
          primaryCdn: null,
        },
        redirectCount: 1,
        bodyBytes: 0,
        probeVersion: '1',
        startedAt: '2026-08-30T00:00:00.000Z',
        completedAt: '2026-08-30T00:00:00.012Z',
      }),
    ).toThrow();
  });
});
