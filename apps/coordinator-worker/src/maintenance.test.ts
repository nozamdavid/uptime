import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@uptime/cloudflare/postgres';

import { emptyMetrics, parseCheckpoint, runRetention } from './maintenance.js';
import { claimJob, readJob, saveJobState } from './state.js';
import { all, count, first, seedMonitor, seedObservation, seedRound } from './testing-postgres.js';
import { makePostgresDatabase } from './testing.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const config = {
  detailedResultsRetentionDays: 7,
  dnsDiagnosticsRetentionDays: 30,
  retentionBatchSize: 2,
};
let fixture: Awaited<ReturnType<typeof makePostgresDatabase>>;

vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });

async function resetFixture(): Promise<void> {
  await fixture.adminDb.transaction(async (tx) => {
    for (const table of [
      'notification_history',
      'notification_deliveries',
      'monitor_notification_state',
      'monitor_notification_services',
      'network_diagnostics',
      'observations',
      'monitor_daily_uptime',
      'check_runs',
      'sessions',
      'admins',
      'jobs',
      'report_latency_changes',
      'report_cache_revisions',
      'report_publications',
      'monitor_regions',
      'notification_services',
      'monitors',
    ]) {
      await tx.query(`DELETE FROM ${tx.table(table)}`);
    }
  });
}

async function finalize(db: Database, id: string, status: 'complete' | 'partial' = 'complete') {
  await db.query(
    `UPDATE ${db.table('check_runs')} SET status = $1, completed_at = $2, finalized_at = $2 WHERE id = $3`,
    [status, '2026-08-01T01:00:00.000Z', id],
  );
}

beforeAll(async () => {
  fixture = await makePostgresDatabase();
}, 300_000);
afterEach(async () => {
  await resetFixture();
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

describe('retention', () => {
  it('starts empty-history observation cleanup at the cutoff index', async () => {
    const { db } = fixture;
    const plans = await db.transaction(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      return Promise.all([
        tx.query(
          `EXPLAIN (FORMAT JSON) SELECT o.id FROM ${tx.table('observations')} o JOIN ${tx.table('check_runs')} cr ON cr.id = o.check_run_id WHERE o.created_at > $1 AND o.created_at < $2 AND cr.status IN ('complete', 'partial') AND cr.finalized_at IS NOT NULL ORDER BY o.created_at ASC LIMIT $3`,
          ['0000-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 100],
        ),
        tx.query(
          `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${tx.table('observations')} o JOIN ${tx.table('check_runs')} cr ON cr.id = o.check_run_id WHERE o.created_at > $1 AND o.created_at < $2 AND cr.status IN ('complete', 'partial') AND cr.finalized_at IS NOT NULL LIMIT 1`,
          ['0000-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
        ),
      ]);
    });
    const deletePlan = JSON.stringify(plans[0]);
    const existencePlan = JSON.stringify(plans[1]);
    // SET LOCAL makes these eligibility checks independent of tiny-table cost estimates.
    for (const plan of [deletePlan, existencePlan]) {
      expect(plan).toContain('observations_created_at_idx');
      expect(plan).toContain('check_runs_retention_idx');
      expect(plan).toContain('Index');
    }
  });

  it('deletes finalized observations in bounded batches, emptying rounds before deleting them', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {});
    await seedRound(db, {
      id: 'old-full',
      monitorId,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    for (const region of ['us-east', 'us-west', 'eu-west'] as const)
      await seedObservation(db, {
        checkRunId: 'old-full',
        monitorId,
        regionId: region,
        scheduledWindow: '2026-08-01T00:00:00.000Z',
        success: true,
        responseMs: 100,
        createdAt: '2026-08-01T00:00:00.000Z',
      });
    await finalize(db, 'old-full');
    await seedRound(db, {
      id: 'old-empty',
      monitorId,
      windowStartedAt: '2026-08-01T00:01:00.000Z',
      status: 'complete',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const firstPass = await runRetention(db, now, config, {});
    expect(firstPass.observationsDeleted).toBe(2);
    expect(firstPass.checkRunsDeleted).toBe(1);
    expect(await count(db, 'check_runs')).toBe(1);
    expect(firstPass.complete).toBe(false);
    expect(firstPass.checkpoint.checkRunsBefore).toBeDefined();
    const secondPass = await runRetention(db, now, config, firstPass.checkpoint);
    expect(secondPass.observationsDeleted).toBe(1);
    expect(secondPass.checkRunsDeleted).toBe(1);
    expect(secondPass.complete).toBe(true);
    expect(secondPass.checkpoint).toEqual({});
    expect(await count(db, 'check_runs')).toBe(0);
    expect(await count(db, 'observations')).toBe(0);
  });

  it('preserves imported history while pruning newer expired history', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {});
    for (const [id, createdAt] of [
      ['imported', '2026-08-01T00:00:00.000Z'],
      ['staging', '2026-09-01T00:00:00.000Z'],
    ] as const) {
      await seedRound(db, {
        id,
        monitorId,
        windowStartedAt: createdAt,
        status: 'complete',
        finalizedAt: createdAt,
        createdAt,
      });
      await seedObservation(db, {
        checkRunId: id,
        monitorId,
        regionId: 'us-east',
        scheduledWindow: createdAt,
        success: true,
        responseMs: 100,
        createdAt,
      });
    }
    await db.query(
      `INSERT INTO ${db.table('admins')} (id, email, password_hash) VALUES ($1, $2, $3)`,
      ['admin', 'admin@example.com', 'hash'],
    );
    await db.query(
      `INSERT INTO ${db.table('sessions')} (id, admin_id, token_hash, expires_at, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $4, $4)`,
      ['expired-session', 'admin', 'token', '2026-08-01T00:00:00.000Z'],
    );
    const result = await runRetention(
      db,
      now,
      { ...config, historyRetentionPreserveBefore: '2026-08-31T23:59:59.999Z' },
      {
        observationsBefore: '2026-09-10T00:00:00.000Z',
        checkRunsBefore: '2026-09-10T00:00:00.000Z',
        networkDiagnosticsBefore: '2026-09-10T00:00:00.000Z',
      },
    );
    expect(result.complete).toBe(true);
    expect(
      await all<{ id: string }>(db, `SELECT id FROM ${db.table('check_runs')} ORDER BY id`),
    ).toEqual([{ id: 'imported' }]);
    expect(await count(db, 'observations')).toBe(1);
    expect(result.sessionsDeleted).toBe(1);
    expect(await count(db, 'sessions')).toBe(0);
  });

  it('deletes notification history older than 90 days in bounded batches and preserves the cutoff', async () => {
    const { db } = fixture;
    await seedMonitor(db, { id: 'history-monitor' });
    await db.query(
      `INSERT INTO ${db.table('notification_services')} (id, name, provider, enabled, config) VALUES ($1, $2, $3, 1, $4)`,
      ['history-service', 'History', 'telegram', '{"chatId":"123"}'],
    );
    for (const [id, createdAt] of [
      ['expired-1', '2026-06-22T11:00:00.000Z'],
      ['expired-2', '2026-06-22T11:10:00.000Z'],
      ['expired-3', '2026-06-22T11:20:00.000Z'],
      ['expired-4', '2026-06-22T11:30:00.000Z'],
      ['snapshot', '2026-06-20T23:59:59.999Z'],
      ['cutoff', '2026-06-22T12:00:00.000Z'],
      ['recent', '2026-06-22T12:01:00.000Z'],
    ] as const) {
      await db.query(
        `INSERT INTO ${db.table('notification_history')} (id, notification_service_id, monitor_id, monitor_name, monitor_url, provider, kind, status, created_at, text, external_url, error, preview) VALUES ($1, 'history-service', NULL, 'Example', NULL, 'telegram', 'outage', 'sent', $2, 'Example is down', NULL, NULL, '{}')`,
        [id, createdAt],
      );
    }
    const retentionConfig = {
      ...config,
      historyRetentionPreserveBefore: '2026-06-21T00:00:00.000Z',
    };
    const firstPass = await runRetention(db, now, retentionConfig, {});
    expect(firstPass.notificationHistoryDeleted).toBe(2);
    expect(await count(db, 'notification_history')).toBe(5);
    const secondPass = await runRetention(db, now, retentionConfig, firstPass.checkpoint);
    expect(secondPass.notificationHistoryDeleted).toBe(2);
    expect(await count(db, 'notification_history')).toBe(3);
    expect(
      await all<{ id: string }>(
        db,
        `SELECT id FROM ${db.table('notification_history')} ORDER BY id`,
      ),
    ).toEqual([{ id: 'cutoff' }, { id: 'recent' }, { id: 'snapshot' }]);
  });

  it('never deletes observations or rounds for pending/unprocessed work', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {});
    await seedRound(db, {
      id: 'pending-old',
      monitorId,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      status: 'pending',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await seedObservation(db, {
      checkRunId: 'pending-old',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-08-01T00:00:00.000Z',
      success: true,
      responseMs: 100,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await seedRound(db, {
      id: 'unfinalized',
      monitorId,
      windowStartedAt: '2026-08-01T01:00:00.000Z',
      status: 'complete',
      finalizedAt: null,
      createdAt: '2026-08-01T01:00:00.000Z',
    });
    const result = await runRetention(db, now, config, {});
    expect(result.observationsDeleted).toBe(0);
    expect(result.checkRunsDeleted).toBe(0);
    expect(result.complete).toBe(true);
    expect(await count(db, 'check_runs')).toBe(2);
    expect(await count(db, 'observations')).toBe(1);
  });

  it('preserves daily aggregates after raw results are deleted', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {});
    await seedRound(db, {
      id: 'old',
      monitorId,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await seedObservation(db, {
      checkRunId: 'old',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-08-01T00:00:00.000Z',
      success: true,
      responseMs: 100,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await seedObservation(db, {
      checkRunId: 'old',
      monitorId,
      regionId: 'us-west',
      scheduledWindow: '2026-08-01T00:00:00.000Z',
      success: false,
      errorCode: 'timeout',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await finalize(db, 'old');
    const before = await first<{ received_count: number; success_count: number }>(
      db,
      `SELECT received_count, success_count FROM ${db.table('monitor_daily_uptime')} WHERE monitor_id = $1 AND day = $2`,
      [monitorId, '2026-08-01'],
    );
    expect(before).toEqual({ received_count: 2, success_count: 1 });
    const result = await runRetention(db, now, config, {});
    expect(result.complete).toBe(true);
    const after = await first<{ received_count: number; success_count: number; source: string }>(
      db,
      `SELECT received_count, success_count, source FROM ${db.table('monitor_daily_uptime')} WHERE monitor_id = $1 AND day = $2`,
      [monitorId, '2026-08-01'],
    );
    expect(after).toEqual({ received_count: 2, success_count: 1, source: 'calculated' });
  });

  it('respects the delete batch bound across many eligible observations', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {});
    for (let index = 0; index < 5; index += 1) {
      const id = `round-${index}`;
      const window = new Date(
        Date.parse('2026-08-01T00:00:00.000Z') + index * 60_000,
      ).toISOString();
      await seedRound(db, {
        id,
        monitorId,
        windowStartedAt: window,
        status: 'complete',
        finalizedAt: '2026-08-01T01:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
      });
      await seedObservation(db, {
        checkRunId: id,
        monitorId,
        regionId: 'us-east',
        scheduledWindow: window,
        success: true,
        responseMs: 100,
        createdAt: '2026-08-01T00:00:00.000Z',
      });
    }
    const firstPass = await runRetention(db, now, config, {});
    expect(firstPass.observationsDeleted).toBe(2);
    expect(firstPass.checkRunsDeleted).toBeLessThanOrEqual(config.retentionBatchSize);
    expect(firstPass.complete).toBe(false);
    const secondPass = await runRetention(db, now, config, firstPass.checkpoint);
    expect(secondPass.observationsDeleted).toBe(2);
    const thirdPass = await runRetention(db, now, config, secondPass.checkpoint);
    expect(thirdPass.observationsDeleted).toBe(1);
    expect(await count(db, 'observations')).toBe(0);
    expect(thirdPass.complete).toBe(true);
  });

  it('keeps unresolved diagnostics while deleting resolved ones', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {});
    await db.query(
      `INSERT INTO ${db.table('network_diagnostics')} (id, monitor_id, region_id, window_started_at, lifecycle, requested_at, created_at, completed_at) VALUES ($1, $2, 'us-east', '2026-08-01T00:00:00.000Z', 'pending', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL), ($3, $2, 'us-west', '2026-08-01T00:00:00.000Z', 'unavailable', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z')`,
      ['d-pending', monitorId, 'd-complete'],
    );
    const result = await runRetention(db, now, config, {});
    expect(result.networkDiagnosticsDeleted).toBe(1);
    expect(result.complete).toBe(true);
    expect(await count(db, 'network_diagnostics')).toBe(1);
    expect(
      (await first<{ id: string }>(db, `SELECT id FROM ${db.table('network_diagnostics')}`))?.id,
    ).toBe('d-pending');
  });

  it('leaves recent finalized and pending rounds untouched', async () => {
    const { db } = fixture;
    const monitorId = await seedMonitor(db, {});
    await seedRound(db, {
      id: 'recent',
      monitorId,
      windowStartedAt: '2026-09-20T11:00:00.000Z',
      status: 'complete',
      createdAt: '2026-09-20T11:00:00.000Z',
    });
    await seedRound(db, {
      id: 'recent-pending',
      monitorId,
      windowStartedAt: '2026-09-20T11:01:00.000Z',
      createdAt: '2026-09-20T11:00:00.000Z',
    });
    const result = await runRetention(db, now, config, {});
    expect(result.checkRunsDeleted).toBe(0);
    expect(result.observationsDeleted).toBe(0);
    expect(await count(db, 'check_runs')).toBe(2);
  });

  it('parses invalid checkpoints safely', () => {
    expect(parseCheckpoint('not json')).toEqual({});
    expect(parseCheckpoint(null)).toEqual({});
    expect(parseCheckpoint('{"complete":true}')).toEqual({ complete: true });
  });
  it('reports zeroed metrics', () => {
    expect(emptyMetrics(now)).toMatchObject({ dueMonitors: 0, unknownRounds: 0, lastError: null });
  });
});

describe('job leases', () => {
  it('grants a lease to one caller and blocks a live second caller', async () => {
    const { db } = fixture;
    const firstLease = await claimJob(db, 'coordinator', now, 55);
    expect(firstLease).not.toBeNull();
    expect(await claimJob(db, 'coordinator', now, 55)).toBeNull();
    await saveJobState(db, 'coordinator', {
      now,
      leaseToken: firstLease!,
      state: { ok: true },
      completed: true,
    });
    const row = await readJob(db, 'coordinator');
    expect(row?.lease_token).toBeNull();
    expect(row?.state_json).toBe('{"ok":true}');
    expect(row?.last_completed_at).not.toBeNull();
  });
  it('allows reclaiming an expired lease', async () => {
    const { db } = fixture;
    await claimJob(db, 'coordinator', now, 1);
    expect(await claimJob(db, 'coordinator', new Date(now.getTime() + 2_000), 55)).not.toBeNull();
  });
  it('does not let an expired owner clear or overwrite a successor lease', async () => {
    const { db } = fixture;
    const stale = await claimJob(db, 'coordinator', now, 1);
    const later = new Date(now.getTime() + 2_000);
    const successor = await claimJob(db, 'coordinator', later, 55);
    expect(stale).not.toBeNull();
    expect(successor).not.toBeNull();
    await saveJobState(db, 'coordinator', {
      now: later,
      leaseToken: stale!,
      state: { owner: 'stale' },
      completed: true,
    });
    const row = await readJob(db, 'coordinator');
    expect(row?.lease_token).toBe(successor);
    expect(row?.state_json).not.toBe('{"owner":"stale"}');
    expect(row?.last_completed_at).toBeNull();
  });
});
