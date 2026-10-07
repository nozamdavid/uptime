import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './testing/postgres.js';
import { TENANT_TABLES, loadMigrationsForProfile } from './postgres/migrations/plan.js';
import { pgFirst, pgAll } from './postgres/query.js';
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
let fixture: PostgresTestDatabase;
const database = () => fixture.db;

async function seedMonitor(id: string, nextCheckAt: string): Promise<MonitorRow> {
  const db = database();
  await db.query(
    `INSERT INTO ${db.table('monitors')} (id, name, url, interval_seconds, timeout_ms, enabled, next_check_at, public_slug)
    VALUES ($1, 'Example', 'https://example.com', 60, 1000, 1, $2, $3)`,
    [id, nextCheckAt, `monitor-${id}`],
  );
  await db.query(
    `INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id) VALUES ($1, 'us-east'), ($1, 'eu-west')`,
    [id],
  );
  return monitorRow(id);
}

async function monitorRow(id: string): Promise<MonitorRow> {
  const db = database();
  return (await pgFirst<MonitorRow>(db, `SELECT * FROM ${db.table('monitors')} WHERE id = $1`, [
    id,
  ]))!;
}

async function seedRound(
  options: { count?: number; expiredLease?: boolean; window?: string; deadline?: string } = {},
) {
  const db = database();
  const window = options.window ?? '2026-09-20T09:00:00.000Z';
  await db.query(
    `INSERT INTO ${db.table('check_runs')}
    (id, monitor_id, window_started_at, expected_region_count, monitor_url, timeout_ms, deadline_at, claim_token, claim_expires_at)
    VALUES ('r1', 'm1', $1, $2, 'https://example.com', 1000, $3, $4, $5)`,
    [
      window,
      options.count ?? 2,
      options.deadline ?? '2026-09-20T09:00:16.000Z',
      options.expiredLease ? 'old' : null,
      options.expiredLease ? '2026-09-20T09:00:30.000Z' : null,
    ],
  );
}

const context = (token = 'coordinator-a') => ({
  db: database(),
  now,
  enabledRegionIds: ['us-east', 'eu-west'] as const,
  claimToken: token,
});
const input = (regionId: 'us-east' | 'eu-west' = 'us-east', checkRunId = 'r1') => ({
  checkRunId,
  monitorId: 'm1',
  regionId,
  scheduledWindow: '2026-09-20T10:00:00.000Z',
  status: 'success' as const,
  success: true,
  httpStatus: 200,
  responseMs: 100,
  startedAt: '2026-09-20T10:00:05.000Z',
});

describe('nextCheckAt', () => {
  it('advances from the schedule, not completion time, skipping missed windows', () => {
    expect(nextCheckAt('2026-09-20T09:00:00.000Z', 60, now)).toBe('2026-09-20T10:01:00.000Z');
    expect(nextCheckAt('2026-09-20T09:59:30.000Z', 60, now)).toBe('2026-09-20T10:00:30.000Z');
    expect(nextCheckAt('2026-09-20T10:00:00.000Z', 300, now)).toBe('2026-09-20T10:05:00.000Z');
  });
});

describe('coordinator storage helpers', () => {
  beforeAll(async () => {
    fixture = await createPostgresTestDatabase({
      migrations: await loadMigrationsForProfile('legacy-staging'),
      profile: 'legacy-staging',
      tables: [...TENANT_TABLES, 'staging_workspace_identity'],
    });
  }, 60_000);
  beforeEach(async () => {
    await fixture.adminDb.query(`TRUNCATE ${database().table('monitors')} CASCADE`);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  }, 60_000);

  it('bounds recovered pending work by regional tasks rather than round count', async () => {
    const db = database();
    await seedMonitor('pending-monitor', '2026-09-20T10:01:00.000Z');
    for (let index = 0; index < 20; index += 1) {
      await db.query(
        `INSERT INTO ${db.table('check_runs')}
        (id, monitor_id, window_started_at, expected_region_count, expected_regions, monitor_url, timeout_ms, deadline_at)
        VALUES ($1, 'pending-monitor', $2, 9, $3, 'https://example.com', 1000, '2026-09-20T11:00:00.000Z')`,
        [
          `pending-${index}`,
          new Date(now.getTime() + index).toISOString(),
          JSON.stringify(regionIds),
        ],
      );
    }
    expect(
      await claimPendingRounds({
        ...context('weighted-owner'),
        enabledRegionIds: regionIds,
        batchSize: 50,
        regionalTaskBudget: 108,
      }),
    ).toHaveLength(12);
  }, 60_000);

  it('keeps a slow queued batch leased and pending through the next minute', async () => {
    const db = database();
    const ids = Array.from({ length: 12 }, (_, index) => `monitor-${index}`);
    const monitors = (
      await db.query<MonitorRow>(
        `INSERT INTO ${db.table('monitors')}
      (id, name, url, interval_seconds, timeout_ms, enabled, next_check_at, public_slug)
      SELECT id, 'Example', 'https://example.com', 60, 30000, 1, $2, id
      FROM unnest($1::text[]) AS seeded(id) RETURNING *`,
        [ids, now.toISOString()],
      )
    ).rows;
    await db.query(
      `INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id)
      SELECT id, region_id FROM unnest($1::text[]) AS seeded(id)
      CROSS JOIN unnest($2::text[]) AS regions(region_id)`,
      [ids, ['us-east', 'eu-west']],
    );
    expect(
      await claimDueRounds(
        {
          ...context('slow-owner'),
          enabledRegionIds: regionIds,
          batchSize: 12,
          probeConcurrency: 32,
          probeBatchSize: 5,
        },
        monitors,
      ),
    ).toHaveLength(12);
    const timing = await pgFirst(
      db,
      `SELECT min(deadline_at) AS deadline, min(claim_expires_at) AS lease FROM ${db.table('check_runs')}`,
    );
    expect(timing).toEqual({
      deadline: '2026-09-20T10:02:45.000Z',
      lease: '2026-09-20T10:02:45.000Z',
    });
    const nextMinute = {
      ...context('next-owner'),
      now: new Date(now.getTime() + 60_000),
      enabledRegionIds: regionIds,
      batchSize: 12,
    };
    expect(await reclaimExpiredRounds(nextMinute)).toEqual({ pending: 0, expired: 0 });
    expect(await claimPendingRounds(nextMinute)).toHaveLength(0);
    expect(
      (
        await pgFirst<{ c: number }>(
          db,
          `SELECT count(*)::integer AS c FROM ${db.table('check_runs')} WHERE claim_token = 'slow-owner'`,
        )
      )?.c,
    ).toBe(12);
  }, 60_000);

  it('claims due monitors atomically and creates rounds exactly once', async () => {
    await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    const first = await claimDueRounds(context(), [await monitorRow('m1')]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      monitorId: 'm1',
      windowStartedAt: '2026-09-20T09:59:00.000Z',
      regionIds: ['eu-west', 'us-east'],
    });
    expect((await monitorRow('m1')).next_check_at).toBe('2026-09-20T10:01:00.000Z');
    expect(await claimDueRounds(context(), [await monitorRow('m1')])).toHaveLength(0);
    expect(
      (await database().query(`SELECT 1 FROM ${database().table('check_runs')}`)).rowCount,
    ).toBe(1);
  }, 30_000);

  it('creates no round when the monitor has no enabled regions', async () => {
    const m = await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    expect(await claimDueRounds({ ...context(), enabledRegionIds: ['asia'] }, [m])).toHaveLength(0);
    expect(
      (await database().query(`SELECT 1 FROM ${database().table('check_runs')}`)).rowCount,
    ).toBe(0);
  }, 30_000);

  it('does not advance a monitor whose schedule changed concurrently', async () => {
    const staleRow = await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    await database().query(
      `UPDATE ${database().table('monitors')} SET next_check_at = '2026-09-20T10:30:00.000Z' WHERE id = 'm1'`,
    );
    expect(await claimDueRounds(context('coordinator-b'), [staleRow])).toHaveLength(0);
    expect((await monitorRow('m1')).next_check_at).toBe('2026-09-20T10:30:00.000Z');
  }, 30_000);

  it('does not skip a window when the schedule advance and round insert are atomic', async () => {
    const m = await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    const claimed = await claimDueRounds(context('c'), [m]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.windowStartedAt).toBe('2026-09-20T09:59:00.000Z');
    expect((await monitorRow('m1')).next_check_at).toBe('2026-09-20T10:01:00.000Z');
    expect(
      await pgFirst(
        database(),
        `SELECT status, window_started_at FROM ${database().table('check_runs')}`,
      ),
    ).toEqual({ status: 'pending', window_started_at: '2026-09-20T09:59:00.000Z' });
  }, 30_000);

  it('reclaims expired leases and finalizes overdue rounds', async () => {
    await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    await claimPendingRounds(context());
    await seedRound({ expiredLease: true });
    expect(await reclaimExpiredRounds(context())).toEqual({ pending: 1, expired: 1 });
    const round = await getRound(database(), 'r1');
    expect(round?.status).toBe('partial');
    expect(round?.finalized_at).not.toBeNull();
  }, 30_000);

  it('reclaims an expired-leased round with all results as complete, not partial', async () => {
    await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    await seedRound({ expiredLease: true });
    for (const region of ['us-east', 'eu-west'] as const)
      await insertObservation(database(), input(region));
    expect((await reclaimExpiredRounds(context('c'))).expired).toBe(1);
    expect((await getRound(database(), 'r1'))?.status).toBe('complete');
    const daily = await pgAll<{ received_count: number; success_count: number }>(
      database(),
      `SELECT received_count, success_count FROM ${database().table('monitor_daily_uptime')}`,
    );
    expect(Number(daily[0]?.received_count)).toBe(2);
    expect(Number(daily[0]?.success_count)).toBe(2);
  }, 30_000);

  it('returns the persisted observation id when a duplicate insert is a no-op', async () => {
    await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    await seedRound({ count: 1 });
    const first = await insertObservation(database(), input());
    const duplicate = await insertObservation(database(), input());
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.id).toBe(first.id);
  }, 30_000);

  it('finalizes a round after every expected result and is idempotent', async () => {
    const m = await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    const [round] = await claimDueRounds(context('c'), [m]);
    for (const region of ['us-east', 'eu-west'] as const)
      await insertObservation(database(), input(region, round!.id));
    expect(await finalizeRound(database(), round!.id)).toBe('complete');
    expect(await finalizeRound(database(), round!.id)).toBeNull();
    const daily = await pgFirst<{
      received_count: number;
      success_count: number;
      uptime_percentage: number;
    }>(
      database(),
      `SELECT received_count, success_count, uptime_percentage FROM ${database().table('monitor_daily_uptime')}`,
    );
    expect(Number(daily?.received_count)).toBe(2);
    expect(Number(daily?.success_count)).toBe(2);
    expect(Number(daily?.uptime_percentage)).toBe(100);
  }, 30_000);

  it('treats duplicate observations as no-ops', async () => {
    await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    await seedRound({ count: 2, deadline: '2026-09-20T10:00:16.000Z' });
    expect((await insertObservation(database(), input())).inserted).toBe(true);
    expect((await insertObservation(database(), input())).inserted).toBe(false);
    expect(await finalizeRound(database(), 'r1', now)).toBeNull();
    expect(
      (await database().query(`SELECT 1 FROM ${database().table('observations')}`)).rowCount,
    ).toBe(1);
  }, 30_000);

  it('finalizes rounds whose deadline elapsed with missing results as partial', async () => {
    await seedMonitor('m1', '2026-09-20T09:59:00.000Z');
    await seedRound();
    expect(await finalizeExpiredRounds(context('c'))).toBe(1);
    expect((await getRound(database(), 'r1'))?.status).toBe('partial');
    expect(
      await pgAll(database(), `SELECT * FROM ${database().table('monitor_daily_uptime')}`),
    ).toHaveLength(0);
  }, 30_000);

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
    expect(nowIso(now)).toBe('2026-09-20T10:00:00.000Z');
  });
});
