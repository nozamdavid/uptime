import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@uptime/cloudflare/postgres';

import {
  finalizeStaleDiagnostics,
  persistDiagnostic,
  reserveDiagnostics,
  utcDayWindow,
} from './diagnostics.js';
import { makePostgresDatabase } from './testing.js';

let fixture: Awaited<ReturnType<typeof makePostgresDatabase>>;

async function seedMonitor(db: Database, id: string): Promise<void> {
  await db.query(
    `INSERT INTO ${db.table('monitors')}
      (id, name, url, interval_seconds, timeout_ms, next_check_at, updated_at)
     VALUES ($1, 'Example', 'https://example.com/health', 60, 1000, $2, $2)`,
    [id, '2026-09-20T10:00:00.000Z'],
  );
  await db.query(
    `INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id)
     VALUES ($1, 'us-east')`,
    [id],
  );
}

async function seedRound(db: Database, id: string, monitorId: string): Promise<void> {
  await db.query(
    `INSERT INTO ${db.table('check_runs')}
      (id, monitor_id, window_started_at, expected_region_count, expected_regions,
       monitor_url, timeout_ms, deadline_at)
     VALUES ($1, $2, $3, 1, '["us-east"]', 'https://example.com', 1000, $4)`,
    [id, monitorId, '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:16.000Z'],
  );
}

async function seedPendingDiagnostic(db: Database, monitorId: string): Promise<void> {
  await db.query(
    `INSERT INTO ${db.table('network_diagnostics')}
      (monitor_id, region_id, window_started_at, lifecycle, requested_at)
     VALUES ($1, 'us-east', '2026-09-20T00:00:00.000Z', 'pending', '2026-09-20T09:00:00.000Z')`,
    [monitorId],
  );
}

const now = new Date('2026-09-20T10:00:00.000Z');

describe('utcDayWindow', () => {
  it('truncates to the UTC day', () => {
    expect(utcDayWindow(new Date('2026-09-20T23:59:59.999Z')).toISOString()).toBe(
      '2026-09-20T00:00:00.000Z',
    );
  });
});

describe('dns diagnostics', () => {
  beforeAll(async () => {
    fixture = await makePostgresDatabase();
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
  }, 180_000);

  it('reserves once per monitor/region/day and records completion', async () => {
    const { db } = fixture;
    const monitorId = `diagnostics-${crypto.randomUUID()}`;
    await seedMonitor(db, monitorId);
    const round = {
      id: crypto.randomUUID(),
      monitorId,
      windowStartedAt: '2026-09-20T10:00:00.000Z',
    };
    // A round row is required by the network_diagnostics FK.
    await seedRound(db, round.id, monitorId);
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
    const row = (
      await db.query<{ lifecycle: string; failure_code: string | null }>(
        `SELECT lifecycle, failure_code FROM ${db.table('network_diagnostics')} WHERE id = $1`,
        [reserved.id],
      )
    ).rows[0];
    expect(row).toEqual({ lifecycle: 'complete', failure_code: null });
  });

  it('marks an invalid diagnostic result unavailable without failing the target', async () => {
    const { db } = fixture;
    const monitorId = `diagnostics-${crypto.randomUUID()}`;
    await seedMonitor(db, monitorId);
    const roundId = crypto.randomUUID();
    await seedRound(db, roundId, monitorId);
    const reserved = (
      await reserveDiagnostics(db, { id: roundId, monitorId, windowStartedAt: now.toISOString() }, [
        'us-east',
      ])
    ).get('us-east')!;
    await persistDiagnostic(db, reserved, null, { kind: 'invalid' });
    const row = (
      await db.query<{ lifecycle: string; failure_code: string }>(
        `SELECT lifecycle, failure_code FROM ${db.table('network_diagnostics')} WHERE id = $1`,
        [reserved.id],
      )
    ).rows[0];
    expect(row).toEqual({ lifecycle: 'unavailable', failure_code: 'protocol_invalid_response' });
  });

  it('abandons stale pending diagnostics', async () => {
    const { db } = fixture;
    const monitorId = `diagnostics-${crypto.randomUUID()}`;
    await seedMonitor(db, monitorId);
    await seedPendingDiagnostic(db, monitorId);
    const changed = await finalizeStaleDiagnostics(db, now);
    expect(changed).toBe(1);
    const row = (
      await db.query<{ lifecycle: string; failure_code: string }>(
        `SELECT lifecycle, failure_code FROM ${db.table('network_diagnostics')}
         WHERE monitor_id = $1 AND region_id = 'us-east'`,
        [monitorId],
      )
    ).rows[0];
    expect(row).toEqual({ lifecycle: 'unavailable', failure_code: 'scheduler_abandoned' });
  });
});
