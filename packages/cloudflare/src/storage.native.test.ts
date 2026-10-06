import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './testing/postgres.js';
import { TENANT_TABLES, loadMigrationsForProfile } from './postgres/migrations/plan.js';
import type { Database } from './postgres/database.js';
import type { MonitorRow } from './types.js';
import { claimDueRounds, claimPendingRounds, finalizeRound, insertObservation } from './storage.js';

const now = new Date('2026-10-05T10:00:00.000Z');
let fixture: PostgresTestDatabase;
let other: Database;

async function monitor(id: string): Promise<MonitorRow> {
  const db = fixture.db;
  return (
    await db.query<MonitorRow>(
      `INSERT INTO ${db.table('monitors')}
    (id, url, interval_seconds, timeout_ms, next_check_at)
    VALUES ($1, 'https://example.com', 60, 1000, $2) RETURNING *`,
      [id, now.toISOString()],
    )
  ).rows[0]!;
}

async function round(id: string, monitorId: string, count = 1) {
  const db = fixture.db;
  await db.query(
    `INSERT INTO ${db.table('check_runs')}
    (id, monitor_id, window_started_at, expected_region_count, expected_regions, monitor_url, timeout_ms, deadline_at)
    VALUES ($1, $2, $3, $4, '["us-east"]', 'https://example.com', 1000, $5)`,
    [id, monitorId, now.toISOString(), count, '2026-10-05T11:00:00.000Z'],
  );
}

function observation(runId: string, monitorId: string) {
  return {
    checkRunId: runId,
    monitorId,
    regionId: 'us-east' as const,
    scheduledWindow: now.toISOString(),
    status: 'success' as const,
    success: true,
    responseMs: 12,
    startedAt: now.toISOString(),
  };
}

describe('native scheduler storage', () => {
  beforeAll(async () => {
    fixture = await createPostgresTestDatabase({
      migrations: await loadMigrationsForProfile('legacy-staging'),
      profile: 'legacy-staging',
      tables: [...TENANT_TABLES, 'staging_workspace_identity'],
    });
    other = await fixture.openConnection();
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  }, 60_000);

  it('advances and inserts a due window once across independent connections', async () => {
    const m = await monitor('claim|arbitrary-text');
    await fixture.db.query(
      `INSERT INTO ${fixture.db.table('monitor_regions')} (monitor_id, region_id)
      VALUES ($1, 'us-east')`,
      [m.id],
    );
    const context = { now, enabledRegionIds: ['us-east' as const], claimToken: 'first' };
    const [a, b] = await Promise.all([
      claimDueRounds({ ...context, db: fixture.db }, [m]),
      claimDueRounds({ ...context, db: other, claimToken: 'second' }, [m]),
    ]);
    expect(a.length + b.length).toBe(1);
    const persisted = await fixture.db.query<{ count: number }>(
      `SELECT count(*)::integer AS count
      FROM ${fixture.db.table('check_runs')} WHERE monitor_id = $1`,
      [m.id],
    );
    expect(persisted.rows[0]?.count).toBe(1);
    expect(
      (
        await fixture.db.query<MonitorRow>(
          `SELECT * FROM ${fixture.db.table('monitors')} WHERE id = $1`,
          [m.id],
        )
      ).rows[0]?.next_check_at,
    ).toBe('2026-10-05T10:01:00.000Z');
  });

  it('skips a locked claim and never grants one live round twice', async () => {
    const m = await monitor('pending-race');
    await round('locked-round', m.id);
    await fixture.db.transaction(async (tx) => {
      await tx.query(`SELECT id FROM ${tx.table('check_runs')} WHERE id = $1 FOR UPDATE`, [
        'locked-round',
      ]);
      expect(
        await claimPendingRounds({
          db: other,
          now,
          enabledRegionIds: ['us-east'],
          claimToken: 'contender',
        }),
      ).toEqual([]);
    });
    const [a, b] = await Promise.all([
      claimPendingRounds({ db: fixture.db, now, enabledRegionIds: ['us-east'], claimToken: 'one' }),
      claimPendingRounds({ db: other, now, enabledRegionIds: ['us-east'], claimToken: 'two' }),
    ]);
    expect([...a, ...b].filter((r) => r.id === 'locked-round')).toHaveLength(1);
  });

  it('waits for an observation then finalizes from a fresh snapshot exactly once', async () => {
    const m = await monitor('finalize-race');
    await round('finalize-run', m.id);
    const pid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let pending!: Promise<unknown>;
    await fixture.db.transaction(async (tx) => {
      await insertObservation(tx, observation('finalize-run', m.id));
      pending = finalizeRound(other, 'finalize-run', now);
      // Confirm server-side waiting rather than relying on a sleep.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await fixture.adminDb.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted) AS waiting`,
          [pid],
        );
        if (activity.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    });
    expect(await pending).toBe('complete');
    expect(await finalizeRound(fixture.db, 'finalize-run', now)).toBeNull();
    const duplicate = await insertObservation(other, observation('finalize-run', m.id));
    expect(duplicate.inserted).toBe(false);
    const rows = await fixture.db.query<{ received_count: number; success_count: number }>(
      `SELECT received_count, success_count FROM ${fixture.db.table('monitor_daily_uptime')} WHERE monitor_id = $1`,
      [m.id],
    );
    expect(Number(rows.rows[0]?.received_count)).toBe(1);
    expect(Number(rows.rows[0]?.success_count)).toBe(1);
  }, 30_000);

  it('serializes an observation behind finalization and adds late evidence once', async () => {
    const m = await monitor('finalizer-first');
    await round('finalizer-first-run', m.id);
    const pid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: Database = {
      ...fixture.db,
      transaction: (callback) =>
        fixture.db.transaction((tx) =>
          callback({
            ...tx,
            async query<T extends object>(sql: string, values?: readonly unknown[]) {
              const result = await tx.query<T>(sql, values);
              if (sql.includes('FOR NO KEY UPDATE')) {
                locked();
                await gate;
              }
              return result;
            },
          }),
        ),
    };
    const finalizing = finalizeRound(
      gated,
      'finalizer-first-run',
      new Date('2026-10-05T12:00:00.000Z'),
    );
    await Promise.race([ready, finalizing]);
    const inserting = insertObservation(other, observation('finalizer-first-run', m.id));
    const outcomes = Promise.allSettled([finalizing, inserting]);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const check = await fixture.adminDb.query<{ count: number }>(
          'SELECT cardinality(pg_blocking_pids($1))::integer AS count',
          [pid],
        );
        if (check.rows[0]!.count > 0) {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      await outcomes;
    }
    expect(await finalizing).toBe('partial');
    expect((await inserting).inserted).toBe(true);
    expect(
      (await insertObservation(other, observation('finalizer-first-run', m.id))).inserted,
    ).toBe(false);
    const daily = await fixture.db.query<{ received_count: number }>(
      `SELECT received_count FROM ${fixture.db.table('monitor_daily_uptime')} WHERE monitor_id = $1`,
      [m.id],
    );
    expect(Number(daily.rows[0]?.received_count)).toBe(1);
  }, 30_000);
});
