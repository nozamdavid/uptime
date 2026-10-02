import { describe, expect, it } from 'vitest';
import { createD1Adapter, createTestDatabase } from './testing/sqlite.js';
import type { D1Database } from './workers-types.js';
import {
  claimDueRounds,
  claimPendingRounds,
  finalizeExpiredRounds,
  finalizeRound,
  getRound,
  insertObservation,
  nextCheckAt,
  parseUptimeThresholds,
  reclaimExpiredRounds,
} from './storage.js';
import { nowIso } from './crypto.js';
import type { MonitorRow } from './types.js';
import { regionIds } from './regions.js';

const now = new Date('2026-09-20T10:00:00.000Z');

type TestDb = ReturnType<typeof createD1Adapter>;

function seedMonitor(db: ReturnType<typeof createTestDatabase>, id: string, nextCheckAt: string) {
  db.prepare(
    `INSERT INTO monitors (id, name, url, interval_seconds, timeout_ms, enabled, next_check_at, public_slug)
     VALUES (?, 'Example', 'https://example.com', 60, 1000, 1, ?, 'example')`,
  ).run(id, nextCheckAt);
  db.prepare("INSERT INTO monitor_regions (monitor_id, region_id) VALUES (?, 'us-east')").run(id);
  db.prepare("INSERT INTO monitor_regions (monitor_id, region_id) VALUES (?, 'eu-west')").run(id);
}

function monitorRow(db: ReturnType<typeof createTestDatabase>, id: string): MonitorRow {
  return db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as unknown as MonitorRow;
}

describe('nextCheckAt', () => {
  it('advances from the schedule, not completion time, skipping missed windows', () => {
    expect(nextCheckAt('2026-09-20T09:00:00.000Z', 60, now)).toBe('2026-09-20T10:01:00.000Z');
    expect(nextCheckAt('2026-09-20T09:59:30.000Z', 60, now)).toBe('2026-09-20T10:00:30.000Z');
    expect(nextCheckAt('2026-09-20T10:00:00.000Z', 300, now)).toBe('2026-09-20T10:05:00.000Z');
  });
});

describe('coordinator storage helpers', () => {
  it('bounds recovered pending work by regional tasks rather than round count', async () => {
    const sqlite = createTestDatabase();
    const db = createD1Adapter(sqlite);
    seedMonitor(sqlite, 'pending-monitor', '2026-09-20T10:01:00.000Z');
    const insert = sqlite.prepare(
      `INSERT INTO check_runs (
         id, monitor_id, window_started_at, expected_region_count, expected_regions,
         monitor_url, timeout_ms, deadline_at
       ) VALUES (?, 'pending-monitor', ?, 9,
         '["us-east","us-west","canada-central","eu-west","eu-north","eu-south","asia","asia-east","asia-south"]',
         'https://example.com', 1000, '2026-09-20T11:00:00.000Z')`,
    );
    for (let index = 0; index < 20; index += 1) {
      insert.run(`pending-${index}`, new Date(now.getTime() + index).toISOString());
    }
    const claimed = await claimPendingRounds({
      db: db as D1Database,
      now,
      enabledRegionIds: regionIds,
      claimToken: 'weighted-owner',
      batchSize: 50,
      regionalTaskBudget: 108,
    });
    expect(claimed).toHaveLength(12);
    db.close();
  });

  it('keeps a slow queued batch leased and pending through the next minute', async () => {
    const sqlite = createTestDatabase();
    const db = createD1Adapter(sqlite);
    const monitors: MonitorRow[] = [];
    for (let index = 0; index < 12; index += 1) {
      const id = `m${index}`;
      seedMonitor(sqlite, id, '2026-09-20T10:00:00.000Z');
      sqlite
        .prepare('UPDATE monitors SET timeout_ms = 30000, public_slug = ? WHERE id = ?')
        .run(`monitor-${index}`, id);
      monitors.push(monitorRow(sqlite, id));
    }
    const first = await claimDueRounds(
      {
        db: db as D1Database,
        now,
        enabledRegionIds: regionIds,
        claimToken: 'slow-owner',
        batchSize: 12,
        probeConcurrency: 32,
        probeBatchSize: 5,
      },
      monitors,
    );
    expect(first).toHaveLength(12);
    const timing = sqlite
      .prepare(
        'SELECT min(deadline_at) AS deadline, min(claim_expires_at) AS lease FROM check_runs',
      )
      .get() as { deadline: string; lease: string };
    expect(timing).toEqual({
      deadline: '2026-09-20T10:02:45.000Z',
      lease: '2026-09-20T10:02:45.000Z',
    });

    const nextMinute = {
      db: db as D1Database,
      now: new Date(now.getTime() + 60_000),
      enabledRegionIds: regionIds,
      claimToken: 'next-owner',
      batchSize: 12,
      probeConcurrency: 32,
      probeBatchSize: 5,
    };
    expect(await reclaimExpiredRounds(nextMinute)).toEqual({ pending: 0, expired: 0 });
    expect(await claimPendingRounds(nextMinute)).toHaveLength(0);
    expect(
      (
        sqlite
          .prepare("SELECT count(*) AS c FROM check_runs WHERE claim_token = 'slow-owner'")
          .get() as { c: number }
      ).c,
    ).toBe(12);
    db.close();
  });

  it('claims due monitors atomically and creates rounds exactly once', async () => {
    const sqlite = createTestDatabase();
    const db = createD1Adapter(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    const context = {
      db: db as D1Database,
      now,
      enabledRegionIds: ['us-east', 'eu-west'] as const,
      claimToken: 'coordinator-a',
    };
    const first = await claimDueRounds(context, [monitorRow(sqlite, 'm1')]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      monitorId: 'm1',
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      regionIds: ['eu-west', 'us-east'],
    });
    // The missed 10:00 window is skipped, matching scheduler semantics.
    expect(monitorRow(sqlite, 'm1').next_check_at).toBe('2026-09-20T10:01:00.000Z');

    // No longer due at the same schedule.
    const second = await claimDueRounds(context, [monitorRow(sqlite, 'm1')]);
    expect(second).toHaveLength(0);
    expect((sqlite.prepare('SELECT count(*) AS c FROM check_runs').get() as { c: number }).c).toBe(
      1,
    );
    db.close();
  });

  it('creates no round when the monitor has no enabled regions', async () => {
    const sqlite = createTestDatabase();
    const db = createD1Adapter(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    const claimed = await claimDueRounds(
      {
        db: db as D1Database,
        now,
        enabledRegionIds: ['asia'], // monitor only has us-east and eu-west
        claimToken: 'coordinator-a',
      },
      [monitorRow(sqlite, 'm1')],
    );
    expect(claimed).toHaveLength(0);
    expect((sqlite.prepare('SELECT count(*) AS c FROM check_runs').get() as { c: number }).c).toBe(
      0,
    );
    db.close();
  });

  it('does not advance a monitor whose schedule changed concurrently', async () => {
    const sqlite = createTestDatabase();
    const db = createD1Adapter(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    const staleRow = monitorRow(sqlite, 'm1');
    // Another coordinator advances the schedule first.
    sqlite
      .prepare("UPDATE monitors SET next_check_at = '2026-09-20T10:30:00.000Z' WHERE id = 'm1'")
      .run();
    const claimed = await claimDueRounds(
      {
        db: db as D1Database,
        now,
        enabledRegionIds: ['us-east', 'eu-west'],
        claimToken: 'coordinator-b',
      },
      [staleRow],
    );
    expect(claimed).toHaveLength(0);
    expect(monitorRow(sqlite, 'm1').next_check_at).toBe('2026-09-20T10:30:00.000Z');
    db.close();
  });

  it('does not skip a window when the schedule advance and round insert are atomic', async () => {
    const sqlite = createTestDatabase();
    const db = createD1Adapter(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    const claimed = await claimDueRounds(
      {
        db: db as D1Database,
        now,
        enabledRegionIds: ['us-east', 'eu-west'],
        claimToken: 'c',
      },
      [monitorRow(sqlite, 'm1')],
    );
    // The advance and the round insert committed together, so the claimed round
    // exists for the exact window that the schedule advanced past.
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.windowStartedAt).toBe('2026-09-20T09:59:00.000Z');
    expect(monitorRow(sqlite, 'm1').next_check_at).toBe('2026-09-20T10:01:00.000Z');
    const run = sqlite.prepare('SELECT status, window_started_at FROM check_runs').get() as {
      status: string;
      window_started_at: string;
    };
    expect(run).toEqual({ status: 'pending', window_started_at: '2026-09-20T09:59:00.000Z' });
    db.close();
  });

  it('reclaims expired leases and finalizes overdue rounds', async () => {
    const sqlite = createTestDatabase();
    const db = createD1Adapter(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    await claimPendingRounds({
      db: db as D1Database,
      now,
      enabledRegionIds: ['us-east'],
      claimToken: 'coordinator-a',
    });
    // No pending rounds exist yet; insert one with an expired claim.
    sqlite
      .prepare(
        `INSERT INTO check_runs (id, monitor_id, window_started_at, status, expected_region_count,
          monitor_url, timeout_ms, deadline_at, claim_token, claim_expires_at)
         VALUES ('r1', 'm1', '2026-09-20T09:00:00.000Z', 'pending', 2, 'https://example.com', 1000,
          '2026-09-20T09:00:16.000Z', 'old', '2026-09-20T09:00:30.000Z')`,
      )
      .run();
    const reclaimed = await reclaimExpiredRounds({
      db: db as D1Database,
      now,
      enabledRegionIds: ['us-east'],
      claimToken: 'coordinator-a',
    });
    expect(reclaimed).toEqual({ pending: 1, expired: 1 });
    const round = await getRound(db as D1Database, 'r1');
    expect(round?.status).toBe('partial');
    expect(round?.finalized_at).not.toBeNull();
    db.close();
  });

  it('reclaims an expired-leased round with all results as complete, not partial', async () => {
    const sqlite = createTestDatabase();
    const db = raw(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO check_runs (id, monitor_id, window_started_at, status, expected_region_count,
          monitor_url, timeout_ms, deadline_at, claim_token, claim_expires_at)
         VALUES ('r1', 'm1', '2026-09-20T09:00:00.000Z', 'pending', 2, 'https://example.com', 1000,
          '2026-09-20T09:00:16.000Z', 'dead', '2026-09-20T09:00:30.000Z')`,
      )
      .run();
    for (const region of ['us-east', 'eu-west'] as const) {
      await insertObservation(db, {
        checkRunId: 'r1',
        monitorId: 'm1',
        regionId: region,
        scheduledWindow: '2026-09-20T09:00:00.000Z',
        status: 'success',
        success: true,
        httpStatus: 200,
        responseMs: 100,
        startedAt: '2026-09-20T09:00:05.000Z',
      });
    }
    const reclaimed = await reclaimExpiredRounds({
      db,
      now,
      enabledRegionIds: ['us-east', 'eu-west'],
      claimToken: 'c',
    });
    expect(reclaimed.expired).toBe(1);
    const round = sqlite.prepare("SELECT status FROM check_runs WHERE id='r1'").get() as {
      status: string;
    };
    expect(round.status).toBe('complete');
    const daily = sqlite
      .prepare('SELECT * FROM monitor_daily_uptime WHERE monitor_id = ?')
      .all('m1');
    expect(daily[0]).toMatchObject({ received_count: 2, success_count: 2 });
    db.close();
  });

  it('returns the persisted observation id when a duplicate insert is a no-op', async () => {
    const sqlite = createTestDatabase();
    const db = raw(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO check_runs (id, monitor_id, window_started_at, expected_region_count,
          monitor_url, timeout_ms, deadline_at)
         VALUES ('r1', 'm1', '2026-09-20T10:00:00.000Z', 1, 'https://example.com', 1000,
          '2026-09-20T10:00:16.000Z')`,
      )
      .run();
    const input = {
      checkRunId: 'r1',
      monitorId: 'm1',
      regionId: 'us-east' as const,
      scheduledWindow: '2026-09-20T10:00:00.000Z',
      status: 'success' as const,
      success: true,
      responseMs: 100,
      startedAt: '2026-09-20T10:00:05.000Z',
    };
    const first = await insertObservation(db, input);
    const duplicate = await insertObservation(db, input);
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    // The duplicate id must reference the persisted row, not a throwaway value.
    expect(duplicate.id).toBe(first.id);
    db.close();
  });

  it('finalizes a round after every expected result and is idempotent', async () => {
    const sqlite = createTestDatabase();
    const db = raw(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    await claimDueRounds(
      {
        db,
        now,
        enabledRegionIds: ['us-east', 'eu-west'],
        claimToken: 'c',
      },
      [monitorRow(sqlite, 'm1')],
    );
    const round = sqlite.prepare('SELECT * FROM check_runs').get() as { id: string };
    for (const region of ['us-east', 'eu-west'] as const) {
      await insertObservation(db, {
        checkRunId: round.id,
        monitorId: 'm1',
        regionId: region,
        scheduledWindow: '2026-09-20T10:00:00.000Z',
        status: 'success',
        success: true,
        httpStatus: 200,
        responseMs: 100,
        startedAt: '2026-09-20T10:00:05.000Z',
      });
    }
    expect(await finalizeRound(db, round.id)).toBe('complete');
    expect(await finalizeRound(db, round.id)).toBeNull();
    const daily = sqlite
      .prepare('SELECT * FROM monitor_daily_uptime WHERE monitor_id = ?')
      .all('m1');
    expect(daily[0]).toMatchObject({
      received_count: 2,
      success_count: 2,
      uptime_percentage: 100,
    });
    db.close();
  });

  it('treats duplicate observations as no-ops', async () => {
    const sqlite = createTestDatabase();
    const db = raw(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO check_runs (id, monitor_id, window_started_at, expected_region_count,
          monitor_url, timeout_ms, deadline_at)
         VALUES ('r1', 'm1', '2026-09-20T10:00:00.000Z', 2, 'https://example.com', 1000,
          '2026-09-20T10:00:16.000Z')`,
      )
      .run();
    const input = {
      checkRunId: 'r1',
      monitorId: 'm1',
      regionId: 'us-east' as const,
      scheduledWindow: '2026-09-20T10:00:00.000Z',
      status: 'success' as const,
      success: true,
      responseMs: 100,
      startedAt: '2026-09-20T10:00:05.000Z',
    };
    expect((await insertObservation(db, input)).inserted).toBe(true);
    expect((await insertObservation(db, input)).inserted).toBe(false);
    expect(await finalizeRound(db, 'r1', now)).toBeNull();
    const completed = sqlite
      .prepare(
        "SELECT status, (SELECT count(*) FROM observations) AS n FROM check_runs WHERE id='r1'",
      )
      .get() as { status: string; n: number };
    expect(completed.n).toBe(1);
    db.close();
  });

  it('finalizes rounds whose deadline elapsed with missing results as partial', async () => {
    const sqlite = createTestDatabase();
    const db = raw(sqlite);
    seedMonitor(sqlite, 'm1', '2026-09-20T09:59:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO check_runs (id, monitor_id, window_started_at, status, expected_region_count,
          monitor_url, timeout_ms, deadline_at)
         VALUES ('r1', 'm1', '2026-09-20T09:00:00.000Z', 'pending', 2, 'https://example.com', 1000,
          '2026-09-20T09:00:16.000Z')`,
      )
      .run();
    expect(
      await finalizeExpiredRounds({ db, now, enabledRegionIds: ['us-east'], claimToken: 'c' }),
    ).toBe(1);
    const round = sqlite.prepare("SELECT status FROM check_runs WHERE id='r1'").get() as {
      status: string;
    };
    expect(round.status).toBe('partial');
    // A partial round with zero results contributes no uptime denominator.
    expect(
      sqlite.prepare('SELECT * FROM monitor_daily_uptime WHERE monitor_id = ?').all('m1'),
    ).toHaveLength(0);
    db.close();
  });

  it('parses public report uptime thresholds with defaults for missing or malformed fields', () => {
    expect(parseUptimeThresholds('{}')).toEqual({ green: 99.5, lightGreen: 99, orange: 90 });
    expect(parseUptimeThresholds('invalid')).toEqual({ green: 99.5, lightGreen: 99, orange: 90 });
    expect(parseUptimeThresholds('{"green":98}')).toEqual({
      green: 98,
      lightGreen: 99,
      orange: 90,
    });
  });

  it('records the current timestamp for finalize bookkeeping', () => {
    expect(nowIso(new Date('2026-09-20T10:00:00.000Z'))).toBe('2026-09-20T10:00:00.000Z');
  });
});

function raw(sqlite: ReturnType<typeof createTestDatabase>): TestDb {
  return createD1Adapter(sqlite);
}
