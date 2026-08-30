import { describe, expect, it, vi } from 'vitest';

import { parseStoredEndpointEvidence } from './endpoint-evidence.js';

const evidence = {
  finalHostname: 'example.com',
  signals: [{ name: 'cf-ray', value: 'abc123-LHR' }],
  primaryCdn: {
    provider: 'cloudflare',
    reportedEdge: 'LHR',
    inferredContinent: 'europe',
    confidence: 'provider_reported',
    evidenceHeader: 'cf-ray',
    parserVersion: 'v1',
  },
};

describe('stored endpoint evidence adapter', () => {
  it('round-trips valid stored evidence', () => {
    const warn = vi.fn();
    expect(
      parseStoredEndpointEvidence(evidence, 'observation-1', 'https://example.com/path', { warn }),
    ).toEqual(evidence);
    expect(warn).not.toHaveBeenCalled();
  });

  it('decodes the JSON string returned by the PostgreSQL adapter', () => {
    const warn = vi.fn();
    expect(
      parseStoredEndpointEvidence(
        JSON.stringify(evidence),
        'observation-1',
        'https://example.com/path',
        { warn },
      ),
    ).toEqual(evidence);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps old NULL observations readable', () => {
    const warn = vi.fn();
    expect(
      parseStoredEndpointEvidence(null, 'observation-1', 'https://example.com/path', { warn }),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails closed for malformed legacy JSON without breaking history', () => {
    const warn = vi.fn();
    expect(
      parseStoredEndpointEvidence(
        { finalHostname: 'example.com', signals: 'bad' },
        'observation-1',
        'https://example.com/path',
        {
          warn,
        },
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { event: 'invalid_legacy_endpoint_evidence', observationId: 'observation-1' },
      'Ignoring invalid stored endpoint evidence',
    );
  });

  it('fails closed for malformed JSONB text', () => {
    const warn = vi.fn();
    expect(
      parseStoredEndpointEvidence('{not JSON', 'observation-1', 'https://example.com/path', {
        warn,
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('contains stored evidence that disagrees with the final URL', () => {
    const warn = vi.fn();
    expect(
      parseStoredEndpointEvidence(evidence, 'observation-1', 'https://other.example/path', {
        warn,
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { event: 'invalid_legacy_endpoint_evidence', observationId: 'observation-1' },
      'Ignoring invalid stored endpoint evidence',
    );
  });
});
