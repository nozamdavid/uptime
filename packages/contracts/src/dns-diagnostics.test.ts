import { describe, expect, it } from 'vitest';

import {
  dnsDiagnosticResultSchema,
  monitorCreateSchema,
  monitorSchema,
  probeRequestSchema,
  probeResponseSchema,
} from './index.js';

const monitorInput = {
  url: 'https://example.com',
  regionIds: ['eu-west'] as const,
  intervalSeconds: 300 as const,
  timeoutMs: 2_000,
};

describe('DNS diagnostic contracts', () => {
  it('defaults DNS diagnostics off for new and legacy stored monitors', () => {
    expect(monitorCreateSchema.parse(monitorInput).dnsDiagnosticsEnabled).toBe(false);
    expect(
      monitorSchema.parse({
        ...monitorInput,
        id: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
        name: null,
        enabled: true,
        createdAt: '2026-08-30T10:00:00.000Z',
        updatedAt: '2026-08-30T10:00:00.000Z',
      }).dnsDiagnosticsEnabled,
    ).toBe(false);
  });

  it('accepts legacy probe requests without a diagnostic instruction', () => {
    const parsed = probeRequestSchema.parse({
      requestId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
      checkRunId: 'ec1e26af-4a95-47a1-9400-3ea1caf03000',
      monitorId: '0ceba4d4-dde0-4e7e-99d7-062517cfa3cf',
      windowStartedAt: '2026-08-30T10:00:00.000Z',
      issuedAt: '2026-08-30T10:00:00.000Z',
      regionId: 'eu-west',
      url: 'https://example.com',
      timeoutMs: 2_000,
      method: 'GET',
      maxRedirects: 5,
      maxBodyBytes: 65_536,
    });
    expect(parsed.dnsDiagnostic).toBeUndefined();
  });

  it('bounds signed diagnostic deadlines and result candidates', () => {
    const base = {
      diagnosticId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
      windowStartedAt: '2026-08-30T00:00:00.000Z',
    };
    expect(
      probeRequestSchema.shape.dnsDiagnostic.unwrap().safeParse({ ...base, deadlineMs: 2_001 })
        .success,
    ).toBe(false);
    expect(
      dnsDiagnosticResultSchema.safeParse({
        ...base,
        finalHostname: 'example.com',
        resolver: 'cloudflare-doh',
        observedAt: '2026-08-30T10:00:00.000Z',
        status: 'success',
        cnameCandidates: Array.from({ length: 9 }, (_, index) => `c${index}.example.com`),
        aCandidates: [],
        aaaaCandidates: [],
        filteredAddressCount: 0,
        errorCode: null,
        schemaVersion: '1',
        parserVersion: '1',
      }).success,
    ).toBe(false);
  });

  it('normalizes rolling-deploy worker responses missing the result to null', () => {
    const parsed = probeResponseSchema.parse({
      regionId: 'eu-west',
      status: 'success',
      success: true,
      httpStatus: 200,
      responseMs: 20,
      totalMs: 25,
      errorCode: null,
      errorDetail: null,
      placement: null,
      colo: null,
      finalUrl: 'https://example.com',
      endpointEvidence: null,
      redirectCount: 0,
      bodyBytes: 2,
      probeVersion: 'old',
      startedAt: '2026-08-30T10:00:00.000Z',
      completedAt: '2026-08-30T10:00:00.025Z',
    });
    expect(parsed.dnsDiagnostic).toBeNull();
  });
});
