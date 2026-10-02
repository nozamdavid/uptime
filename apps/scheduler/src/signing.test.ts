import { describe, expect, it } from 'vitest';

import { signProbeBatchRequest, signProbeRequest } from './signing.js';

describe('signProbeRequest', () => {
  it('binds a unique identity, timestamp, and exact body', () => {
    const signed = signProbeRequest(
      {
        checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
        monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
        windowStartedAt: '2026-08-30T00:00:00.000Z',
        regionId: 'us-east',
        url: 'https://example.com',
        timeoutMs: 1_000,
        method: 'GET',
        maxRedirects: 5,
        maxBodyBytes: 65_536,
      },
      'a'.repeat(32),
      new Date('2026-08-30T00:00:01.000Z'),
    );
    expect(signed.headers['x-uptime-signature-version']).toBe('v1');
    expect(signed.headers['x-uptime-signature']).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(signed.body)).toMatchObject({ regionId: 'us-east' });
  });

  it('signs one same-region batch envelope', () => {
    const signed = signProbeBatchRequest(
      {
        regionId: 'us-east',
        items: [
          {
            checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
            monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
            windowStartedAt: '2026-08-30T00:00:00.000Z',
            url: 'https://example.com',
            timeoutMs: 1_000,
            method: 'GET',
            maxRedirects: 5,
            maxBodyBytes: 65_536,
          },
        ],
      },
      'a'.repeat(32),
      new Date('2026-08-30T00:00:01.000Z'),
    );
    expect(JSON.parse(signed.body)).toMatchObject({
      requestId: signed.requestId,
      issuedAt: '2026-08-30T00:00:01.000Z',
      regionId: 'us-east',
      items: [{ url: 'https://example.com' }],
    });
  });
});
