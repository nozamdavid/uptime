import { describe, expect, it, vi } from 'vitest';

import { parseStoredDnsDiagnostic } from './dns-diagnostics.js';

const result = {
  diagnosticId: 'b46f9f80-7ea6-43c7-a674-4b9a57ac6745',
  windowStartedAt: '2026-08-30T00:00:00.000Z',
  finalHostname: 'example.com',
  resolver: 'cloudflare-doh',
  observedAt: '2026-08-30T00:00:01.000Z',
  status: 'success',
  cnameCandidates: [],
  aCandidates: [{ address: '1.1.1.1', ttl: 60 }],
  aaaaCandidates: [],
  filteredAddressCount: 0,
  errorCode: null,
  schemaVersion: '1',
  parserVersion: '1',
};

describe('stored DNS diagnostics adapter', () => {
  it('round-trips valid JSON and contains malformed legacy rows', () => {
    const warn = vi.fn();
    expect(parseStoredDnsDiagnostic(JSON.stringify(result), 'diagnostic-1', { warn })).toEqual(
      result,
    );
    expect(parseStoredDnsDiagnostic('{bad', 'diagnostic-2', { warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { event: 'invalid_legacy_dns_diagnostic', diagnosticId: 'diagnostic-2' },
      'Ignoring invalid stored DNS diagnostic',
    );
  });
});
