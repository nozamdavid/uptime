import { describe, expect, it } from 'vitest';

import { parseProbeResponse, parseProbeResponseDetails } from './scheduler.js';

const legacyProbeResponse = {
  regionId: 'eu-west',
  status: 'success',
  success: true,
  httpStatus: 200,
  responseMs: 24,
  totalMs: 30,
  errorCode: null,
  errorDetail: null,
  placement: 'aws:eu-west-1',
  colo: 'LHR',
  finalUrl: 'https://example.com/',
  redirectCount: 0,
  bodyBytes: 42,
  probeVersion: '1.0.0',
  startedAt: '2026-08-30T00:00:00.000Z',
  completedAt: '2026-08-30T00:00:00.030Z',
};

describe('probe response compatibility adapter', () => {
  it('normalizes absent evidence from an old Worker to null', () => {
    expect(parseProbeResponse(legacyProbeResponse).endpointEvidence).toBeNull();
  });

  it('contains malformed diagnostics without discarding a valid uptime observation', () => {
    const result = parseProbeResponseDetails({
      ...legacyProbeResponse,
      dnsDiagnostic: { bad: true },
    });
    expect(result.observation.success).toBe(true);
    expect(result.diagnostic).toEqual({ kind: 'invalid' });
  });
});
