import { describe, expect, it } from 'vitest';

import {
  finalizeStaleDiagnostics,
  persistDiagnostic,
  reserveDiagnostics,
  utcDayWindow,
} from './diagnostics.js';
import { makeDatabase, seedMonitor } from './testing.js';

const now = new Date('2026-09-20T10:00:00.000Z');

describe('utcDayWindow', () => {
  it('truncates to the UTC day', () => {
    expect(utcDayWindow(new Date('2026-09-20T23:59:59.999Z')).toISOString()).toBe(
      '2026-09-20T00:00:00.000Z',
    );
  });
});

describe('dns diagnostics', () => {
  it('reserves once per monitor/region/day and records completion', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    const round = {
      id: crypto.randomUUID(),
      monitorId,
      windowStartedAt: '2026-09-20T10:00:00.000Z',
    };
    // A round row is required by the network_diagnostics FK.
    sqlite
      .prepare(
        `INSERT INTO check_runs (id, monitor_id, window_started_at, expected_region_count,
          monitor_url, timeout_ms, deadline_at)
         VALUES (?, ?, '2026-09-20T10:00:00.000Z', 1, 'https://example.com', 1000,
          '2026-09-20T10:00:16.000Z')`,
      )
      .run(round.id, monitorId);
    const first = await reserveDiagnostics(db, round, ['us-east']);
    expect(first.size).toBe(1);
    // A second reservation for the same day is skipped, preserving one snapshot.
    const second = await reserveDiagnostics(db, round, ['us-east', 'eu-west']);
    expect(second.size).toBe(1);
    expect(second.has('eu-west')).toBe(true);

    const reserved = first.get('us-east')!;
    await persistDiagnostic(db, reserved, null, {
      kind: 'complete',
      result: {
        diagnosticId: reserved.id,
        windowStartedAt: reserved.windowStartedAt,
        finalHostname: 'example.com',
        resolver: 'cloudflare-doh',
        observedAt: now.toISOString(),
        status: 'success',
        cnameCandidates: [],
        aCandidates: [{ address: '93.184.216.34', ttl: 60 }],
        aaaaCandidates: [],
        filteredAddressCount: 0,
        errorCode: null,
        schemaVersion: '1',
        parserVersion: '1',
      },
    });
    const row = sqlite
      .prepare('SELECT lifecycle, failure_code FROM network_diagnostics WHERE id = ?')
      .get(reserved.id) as { lifecycle: string; failure_code: string | null };
    expect(row).toEqual({ lifecycle: 'complete', failure_code: null });
  });

  it('marks an invalid diagnostic result unavailable without failing the target', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    const roundId = crypto.randomUUID();
    sqlite
      .prepare(
        `INSERT INTO check_runs (id, monitor_id, window_started_at, expected_region_count,
          monitor_url, timeout_ms, deadline_at)
         VALUES (?, ?, '2026-09-20T10:00:00.000Z', 1, 'https://example.com', 1000,
          '2026-09-20T10:00:16.000Z')`,
      )
      .run(roundId, monitorId);
    const reserved = (
      await reserveDiagnostics(db, { id: roundId, monitorId, windowStartedAt: now.toISOString() }, [
        'us-east',
      ])
    ).get('us-east')!;
    await persistDiagnostic(db, reserved, null, { kind: 'invalid' });
    const row = sqlite
      .prepare('SELECT lifecycle, failure_code FROM network_diagnostics WHERE id = ?')
      .get(reserved.id) as { lifecycle: string; failure_code: string };
    expect(row).toEqual({ lifecycle: 'unavailable', failure_code: 'protocol_invalid_response' });
  });

  it('abandons stale pending diagnostics', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    sqlite
      .prepare(
        `INSERT INTO network_diagnostics (monitor_id, region_id, window_started_at, lifecycle, requested_at)
         VALUES (?, 'us-east', '2026-09-20T00:00:00.000Z', 'pending', '2026-09-20T09:00:00.000Z')`,
      )
      .run(monitorId);
    const changed = await finalizeStaleDiagnostics(db, now);
    expect(changed).toBe(1);
    const row = sqlite
      .prepare(
        "SELECT lifecycle, failure_code FROM network_diagnostics WHERE region_id = 'us-east'",
      )
      .get() as { lifecycle: string; failure_code: string };
    expect(row).toEqual({ lifecycle: 'unavailable', failure_code: 'scheduler_abandoned' });
  });
});
