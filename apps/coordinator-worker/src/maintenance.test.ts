import { describe, expect, it } from 'vitest';

import { emptyMetrics, parseCheckpoint, runRetention } from './maintenance.js';
import { claimJob, readJob, saveJobState } from './state.js';
import { count, makeDatabase, seedMonitor, seedObservation, seedRound } from './testing.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const config = {
  detailedResultsRetentionDays: 7,
  dnsDiagnosticsRetentionDays: 30,
  retentionBatchSize: 2,
};

/** Finalize a seeded pending round through the trigger path. */
function finalize(
  sqlite: ReturnType<typeof makeDatabase>['sqlite'],
  roundId: string,
  status: 'complete' | 'partial' = 'complete',
) {
  sqlite
    .prepare(`UPDATE check_runs SET status = ?, completed_at = ?, finalized_at = ? WHERE id = ?`)
    .run(status, '2026-08-01T01:00:00.000Z', '2026-08-01T01:00:00.000Z', roundId);
}

describe('retention', () => {
  it('starts empty-history observation cleanup at the cutoff index', () => {
    const { sqlite } = makeDatabase();
    const deleteCandidatePlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT o.id FROM observations o INDEXED BY observations_created_at_idx
         CROSS JOIN check_runs cr ON cr.id = o.check_run_id
         WHERE o.created_at > ? AND o.created_at < ?
           AND cr.status IN ('complete', 'partial')
           AND cr.finalized_at IS NOT NULL
         ORDER BY o.created_at ASC LIMIT ?`,
      )
      .all('0000-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 100) as {
      detail: string;
    }[];
    const existencePlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM observations o INDEXED BY observations_created_at_idx
         CROSS JOIN check_runs cr ON cr.id = o.check_run_id
         WHERE o.created_at > ? AND o.created_at < ?
           AND cr.status IN ('complete', 'partial')
           AND cr.finalized_at IS NOT NULL
         LIMIT 1`,
      )
      .all('0000-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z') as {
      detail: string;
    }[];
    for (const plan of [deleteCandidatePlan, existencePlan]) {
      expect(plan[0]?.detail).toContain('observations_created_at_idx');
      expect(plan.map((row) => row.detail).join('\n')).toContain('sqlite_autoindex_check_runs_1');
    }
  });

  it('deletes finalized observations in bounded batches, emptying rounds before deleting them', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    // One finalized round with three observations, and one empty finalized round.
    seedRound(sqlite, {
      id: 'old-full',
      monitorId,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    for (const region of ['us-east', 'us-west', 'eu-west'] as const) {
      seedObservation(sqlite, {
        checkRunId: 'old-full',
        monitorId,
        regionId: region,
        scheduledWindow: '2026-08-01T00:00:00.000Z',
        success: true,
        responseMs: 100,
        createdAt: '2026-08-01T00:00:00.000Z',
      });
    }
    finalize(sqlite, 'old-full');
    seedRound(sqlite, {
      id: 'old-empty',
      monitorId,
      windowStartedAt: '2026-08-01T00:01:00.000Z',
      status: 'complete',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    // Pass 1: two observations removed; no round can be deleted while its
    // observations remain, but the empty round is removed in the same pass.
    const first = await runRetention(db, now, config, {});
    expect(first.observationsDeleted).toBe(2);
    expect(first.checkRunsDeleted).toBe(1);
    expect(count(sqlite, 'check_runs')).toBe(1);
    expect(first.complete).toBe(false);
    expect(first.checkpoint.checkRunsBefore).toBeDefined();

    // Pass 2: final observation removed, then the now-empty round.
    const second = await runRetention(db, now, config, first.checkpoint);
    expect(second.observationsDeleted).toBe(1);
    expect(second.checkRunsDeleted).toBe(1);
    expect(second.complete).toBe(true);
    expect(second.checkpoint).toEqual({});
    expect(count(sqlite, 'check_runs')).toBe(0);
    expect(count(sqlite, 'observations')).toBe(0);
  });

  it('preserves imported history while pruning newer expired history', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    for (const [id, createdAt] of [
      ['imported', '2026-08-01T00:00:00.000Z'],
      ['staging', '2026-09-01T00:00:00.000Z'],
    ] as const) {
      seedRound(sqlite, {
        id,
        monitorId,
        windowStartedAt: createdAt,
        status: 'complete',
        finalizedAt: createdAt,
        createdAt,
      });
      seedObservation(sqlite, {
        checkRunId: id,
        monitorId,
        regionId: 'us-east',
        scheduledWindow: createdAt,
        success: true,
        responseMs: 100,
        createdAt,
      });
    }
    sqlite
      .prepare(
        `INSERT INTO admins (id, email, password_hash)
         VALUES ('admin', 'admin@example.com', 'hash')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO sessions (id, admin_id, token_hash, expires_at, created_at, last_seen_at)
         VALUES ('expired-session', 'admin', 'token', '2026-08-01T00:00:00.000Z',
                 '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      )
      .run();

    const result = await runRetention(
      db,
      now,
      { ...config, historyRetentionPreserveBefore: '2026-08-31T23:59:59.999Z' },
      {
        // A checkpoint created before snapshot protection was configured must
        // still apply the current preservation boundary.
        observationsBefore: '2026-09-10T00:00:00.000Z',
        checkRunsBefore: '2026-09-10T00:00:00.000Z',
        networkDiagnosticsBefore: '2026-09-10T00:00:00.000Z',
      },
    );
    expect(result.complete).toBe(true);
    expect(
      sqlite.prepare('SELECT id FROM check_runs ORDER BY id').all() as { id: string }[],
    ).toEqual([{ id: 'imported' }]);
    expect(count(sqlite, 'observations')).toBe(1);
    expect(result.sessionsDeleted).toBe(1);
    expect(count(sqlite, 'sessions')).toBe(0);
  });

  it('deletes notification history older than 90 days in bounded batches and preserves the cutoff', async () => {
    const { sqlite, db } = makeDatabase();
    sqlite
      .prepare(
        `INSERT INTO notification_services (id, name, provider, enabled, config)
         VALUES ('history-service', 'History', 'telegram', 1, '{"chatId":"123"}')`,
      )
      .run();
    const insertHistory = sqlite.prepare(
      `INSERT INTO notification_history (
         id, notification_service_id, monitor_id, monitor_name, monitor_url, provider,
         kind, status, created_at, text, external_url, error, preview
       ) VALUES (?, 'history-service', NULL, 'Example', NULL, 'telegram', 'outage',
                'sent', ?, 'Example is down', NULL, NULL, '{}')`,
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
      insertHistory.run(id, createdAt);
    }

    const retentionConfig = {
      ...config,
      historyRetentionPreserveBefore: '2026-06-21T00:00:00.000Z',
    };
    const first = await runRetention(db, now, retentionConfig, {});
    expect(first.notificationHistoryDeleted).toBe(2);
    expect(count(sqlite, 'notification_history')).toBe(5);

    const second = await runRetention(db, now, retentionConfig, first.checkpoint);
    expect(second.notificationHistoryDeleted).toBe(2);
    expect(count(sqlite, 'notification_history')).toBe(3);

    const remaining = sqlite.prepare('SELECT id FROM notification_history ORDER BY id').all() as {
      id: string;
    }[];
    expect(remaining).toEqual([{ id: 'cutoff' }, { id: 'recent' }, { id: 'snapshot' }]);
  });

  it('never deletes observations or rounds for pending/unprocessed work', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    seedRound(sqlite, {
      id: 'pending-old',
      monitorId,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      status: 'pending',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    seedObservation(sqlite, {
      checkRunId: 'pending-old',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-08-01T00:00:00.000Z',
      success: true,
      responseMs: 100,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    // A completed round that somehow lacks a finalized marker is also ineligible.
    seedRound(sqlite, {
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
    expect(count(sqlite, 'check_runs')).toBe(2);
    expect(count(sqlite, 'observations')).toBe(1);
  });

  it('preserves daily aggregates after raw results are deleted', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    seedRound(sqlite, {
      id: 'old',
      monitorId,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    seedObservation(sqlite, {
      checkRunId: 'old',
      monitorId,
      regionId: 'us-east',
      scheduledWindow: '2026-08-01T00:00:00.000Z',
      success: true,
      responseMs: 100,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    seedObservation(sqlite, {
      checkRunId: 'old',
      monitorId,
      regionId: 'us-west',
      scheduledWindow: '2026-08-01T00:00:00.000Z',
      success: false,
      errorCode: 'timeout',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    // Finalizing through the UPDATE trigger writes the exact daily aggregate.
    finalize(sqlite, 'old');
    const before = sqlite
      .prepare(
        `SELECT received_count, success_count FROM monitor_daily_uptime
         WHERE monitor_id = ? AND day = '2026-08-01'`,
      )
      .get(monitorId) as { received_count: number; success_count: number };
    expect(before).toEqual({ received_count: 2, success_count: 1 });

    const result = await runRetention(db, now, config, {});
    expect(result.complete).toBe(true);
    const after = sqlite
      .prepare(
        `SELECT received_count, success_count, source FROM monitor_daily_uptime
         WHERE monitor_id = ? AND day = '2026-08-01'`,
      )
      .get(monitorId) as { received_count: number; success_count: number; source: string };
    expect(after).toEqual({ received_count: 2, success_count: 1, source: 'calculated' });
  });

  it('respects the delete batch bound across many eligible observations', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    for (let index = 0; index < 5; index += 1) {
      seedObservation(sqlite, {
        checkRunId: (() => {
          const roundId = `round-${index}`;
          seedRound(sqlite, {
            id: roundId,
            monitorId,
            windowStartedAt: new Date(
              Date.parse('2026-08-01T00:00:00.000Z') + index * 60_000,
            ).toISOString(),
            status: 'complete',
            finalizedAt: '2026-08-01T01:00:00.000Z',
            createdAt: '2026-08-01T00:00:00.000Z',
          });
          return roundId;
        })(),
        monitorId,
        regionId: 'us-east',
        scheduledWindow: new Date(
          Date.parse('2026-08-01T00:00:00.000Z') + index * 60_000,
        ).toISOString(),
        success: true,
        responseMs: 100,
        createdAt: '2026-08-01T00:00:00.000Z',
      });
    }
    const first = await runRetention(db, now, config, {});
    expect(first.observationsDeleted).toBe(2);
    expect(first.checkRunsDeleted).toBeLessThanOrEqual(config.retentionBatchSize);
    expect(first.complete).toBe(false);

    const second = await runRetention(db, now, config, first.checkpoint);
    expect(second.observationsDeleted).toBe(2);
    const third = await runRetention(db, now, config, second.checkpoint);
    expect(third.observationsDeleted).toBe(1);
    // Each round is deleted only after its single observation is gone.
    expect(count(sqlite, 'observations')).toBe(0);
    expect(third.complete).toBe(true);
  });

  it('keeps unresolved diagnostics while deleting resolved ones', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    sqlite
      .prepare(
        `INSERT INTO network_diagnostics
           (id, monitor_id, region_id, window_started_at, lifecycle, requested_at, created_at,
            completed_at)
         VALUES
           ('d-pending', ?, 'us-east', '2026-08-01T00:00:00.000Z', 'pending',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL),
           ('d-complete', ?, 'us-west', '2026-08-01T00:00:00.000Z', 'unavailable',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
            '2026-08-01T00:01:00.000Z')`,
      )
      .run(monitorId, monitorId);
    const result = await runRetention(db, now, config, {});
    expect(result.networkDiagnosticsDeleted).toBe(1);
    // The resolved row is gone; the pending reservation survives as
    // ineligible work, and the eligible pass is complete.
    expect(result.complete).toBe(true);
    expect(count(sqlite, 'network_diagnostics')).toBe(1);
    const remaining = sqlite.prepare('SELECT id FROM network_diagnostics').get() as { id: string };
    expect(remaining.id).toBe('d-pending');
  });

  it('leaves recent finalized and pending rounds untouched', async () => {
    const { sqlite, db } = makeDatabase();
    const monitorId = seedMonitor(sqlite, {});
    seedRound(sqlite, {
      id: 'recent',
      monitorId,
      windowStartedAt: '2026-09-20T11:00:00.000Z',
      status: 'complete',
      createdAt: '2026-09-20T11:00:00.000Z',
    });
    seedRound(sqlite, {
      id: 'recent-pending',
      monitorId,
      windowStartedAt: '2026-09-20T11:01:00.000Z',
      createdAt: '2026-09-20T11:00:00.000Z',
    });
    const result = await runRetention(db, now, config, {});
    expect(result.checkRunsDeleted).toBe(0);
    expect(result.observationsDeleted).toBe(0);
    expect(count(sqlite, 'check_runs')).toBe(2);
  });

  it('parses invalid checkpoints safely', () => {
    expect(parseCheckpoint('not json')).toEqual({});
    expect(parseCheckpoint(null)).toEqual({});
    expect(parseCheckpoint('{"complete":true}')).toEqual({ complete: true });
  });

  it('reports zeroed metrics', () => {
    expect(emptyMetrics(now)).toMatchObject({
      dueMonitors: 0,
      unknownRounds: 0,
      lastError: null,
    });
  });
});

describe('job leases', () => {
  it('grants a lease to one caller and blocks a live second caller', async () => {
    const { db } = makeDatabase();
    const first = await claimJob(db, 'coordinator', now, 55);
    expect(first).not.toBeNull();
    const second = await claimJob(db, 'coordinator', now, 55);
    expect(second).toBeNull();
    await saveJobState(db, 'coordinator', {
      now,
      leaseToken: first!,
      state: { ok: true },
      completed: true,
    });
    const row = await readJob(db, 'coordinator');
    expect(row?.lease_token).toBeNull();
    expect(row?.state_json).toBe('{"ok":true}');
    expect(row?.last_completed_at).not.toBeNull();
  });

  it('allows reclaiming an expired lease', async () => {
    const { db } = makeDatabase();
    await claimJob(db, 'coordinator', now, 1);
    const reclaimed = await claimJob(db, 'coordinator', new Date(now.getTime() + 2_000), 55);
    expect(reclaimed).not.toBeNull();
  });

  it('does not let an expired owner clear or overwrite a successor lease', async () => {
    const { db } = makeDatabase();
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
