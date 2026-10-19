import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@uptime/cloudflare/postgres';
import { insertObservation, finalizeRound } from '@uptime/cloudflare';
import { sealProviderConfig } from '@uptime/api-worker/credentials';
import { makePostgresDatabase } from './testing.js';
import { claimJob, saveJobState, readJob } from './state.js';
import { meterDatabase, QueryBudgetExceeded } from './query-metrics.js';
import { reserveDiagnostics, persistDiagnostic } from './diagnostics.js';
import { backfillLatencyDay, latencyHourReplacementStatements } from './hourly-latency.js';
import { buildFullHistoryMonitorSnapshot } from './full-history.js';
import { processNotifications } from './notifications.js';
import { runRetention } from './maintenance.js';
import { publishDueReports, reportCohortPointerKey } from './publisher.js';
import { FakeR2 } from './testing-r2.js';
import { runCoordinatorTick } from './coordinator.js';
import { parseCoordinatorEnv } from './env.js';
import { runReportJob } from './report-job.js';
import { handleMonitorReport, type MonitorReportEnv } from './on-demand-monitor.js';

const now = new Date('2026-10-05T10:00:00.000Z');
const secret = 'x'.repeat(40);
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
let fixture: Awaited<ReturnType<typeof makePostgresDatabase>>;
let db: Database;
let other: Database;

async function monitor(id: string) {
  await db.query(
    `INSERT INTO ${db.table('monitors')}
    (id, name, url, interval_seconds, timeout_ms, outage_threshold, recovery_threshold, is_public, public_slug, next_check_at, updated_at)
    VALUES ($1, $1, 'https://example.com', 60, 1000, 1, 1, 1, $2, $3, '2026-09-01T00:00:00.000Z')`,
    [id, id.replaceAll('|', '-'), now.toISOString()],
  );
  await db.query(
    `INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id) VALUES ($1, 'us-east')`,
    [id],
  );
}

async function round(id: string, monitorId: string, window = '2026-10-05T09:00:00.000Z') {
  await db.query(
    `INSERT INTO ${db.table('check_runs')}
    (id, monitor_id, window_started_at, expected_region_count, expected_regions, monitor_url, timeout_ms, deadline_at, created_at)
    VALUES ($1, $2, $3, 1, '["us-east"]', 'https://example.com', 1000, $3, $3)`,
    [id, monitorId, window],
  );
}

async function observe(
  connection: Database,
  runId: string,
  monitorId: string,
  window: string,
  responseMs: number,
  success = true,
) {
  return insertObservation(connection, {
    checkRunId: runId,
    monitorId,
    regionId: 'us-east',
    scheduledWindow: window,
    status: success ? 'success' : 'http_failure',
    success,
    responseMs,
    startedAt: window,
  });
}

describe('native coordinator persistence', () => {
  beforeAll(async () => {
    fixture = await makePostgresDatabase();
    db = fixture.db;
    other = await fixture.openConnection();
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  }, 60_000);

  it('grants one job lease and rejects an acknowledgement from an expired owner', async () => {
    const [a, b] = await Promise.all([
      claimJob(db, 'lease-race', now, 60),
      claimJob(other, 'lease-race', now, 60),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const expired = a ?? b!;
    const later = new Date(now.getTime() + 61_000);
    const replacement = await claimJob(other, 'lease-race', later, 60);
    expect(replacement).toBeTruthy();
    await saveJobState(db, 'lease-race', {
      now: later,
      leaseToken: expired,
      state: { stale: true },
      completed: true,
    });
    expect((await readJob(db, 'lease-race'))?.lease_token).toBe(replacement);
    await saveJobState(other, 'lease-race', {
      now: later,
      leaseToken: replacement!,
      state: { fresh: true },
      completed: true,
    });
    expect(JSON.parse((await readJob(db, 'lease-race'))!.state_json!)).toEqual({ fresh: true });
  }, 30_000);

  it('counts real statements and durations through transactions, without row billing', async () => {
    const meter = meterDatabase(db);
    meter.setStage('native');
    meter.setStatementLimit(2);
    await meter.db.query('SELECT 1');
    await meter.db.transaction(async (tx) => {
      await tx.query('SELECT 2');
    });
    expect(meter.work.native?.statements).toBe(2);
    expect(meter.work.native?.durationMs).toBeGreaterThan(0);
    expect(meter.work.native).not.toHaveProperty('rowsRead');
    await expect(meter.db.query('SELECT 3')).rejects.toBeInstanceOf(QueryBudgetExceeded);
  }, 30_000);

  it('reserves diagnostics once and persists unavailable results conditionally', async () => {
    await monitor('diagnostics-native');
    await round('diagnostics-run', 'diagnostics-native');
    const run = {
      id: 'diagnostics-run',
      monitorId: 'diagnostics-native',
      windowStartedAt: now.toISOString(),
    };
    const [a, b] = await Promise.all([
      reserveDiagnostics(db, run, ['us-east']),
      reserveDiagnostics(other, run, ['us-east']),
    ]);
    expect(a.size + b.size).toBe(1);
    const reservation = a.get('us-east') ?? b.get('us-east')!;
    await persistDiagnostic(db, reservation, null, { kind: 'missing' });
    const row = (
      await db.query<{ lifecycle: string }>(
        `SELECT lifecycle FROM ${db.table('network_diagnostics')} WHERE id = $1`,
        [reservation.id],
      )
    ).rows[0];
    expect(row?.lifecycle).toBe('unavailable');
  }, 30_000);

  it('chooses the ordered native maximum and leaves a new concurrent dirty marker', async () => {
    await monitor('latency-native');
    const firstWindow = '2026-10-05T09:01:00.000Z';
    const secondWindow = '2026-10-05T09:02:00.000Z';
    await round('latency-run-one', 'latency-native', firstWindow);
    await round('latency-run-two', 'latency-native', secondWindow);
    await observe(db, 'latency-run-one', 'latency-native', firstWindow, 90);
    const winner = await observe(db, 'latency-run-two', 'latency-native', secondWindow, 90);
    await db.query(
      `UPDATE ${db.table('observations')} SET id = 'max|arbitrary-text-id' WHERE id = $1`,
      [winner.id],
    );
    await backfillLatencyDay(db, 'latency-native', '2026-10-05');
    const payload = JSON.parse(
      (
        await db.query<{ payload: string }>(
          `SELECT payload FROM ${db.table('monitor_latency_hourly')} WHERE monitor_id = $1`,
          ['latency-native'],
        )
      ).rows[0]!.payload,
    );
    expect(payload[0].maximum).toEqual({
      value: 90,
      startedAt: secondWindow,
      id: 'max|arbitrary-text-id',
    });
    expect(payload[0].histogram).toEqual([[90, 2]]);
    const thirdWindow = '2026-10-05T09:03:00.000Z';
    await round('latency-run-three', 'latency-native', thirdWindow);
    // Recreate an existing dirty generation, then contend with its deletion.
    await db.query(
      `INSERT INTO ${db.table('monitor_latency_dirty')} (monitor_id, hour) VALUES ($1, $2)`,
      ['latency-native', '2026-10-05T09:00:00.000Z'],
    );
    const pid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let pending!: Promise<unknown>;
    await db.transaction(async (tx) => {
      const statements = latencyHourReplacementStatements(
        tx,
        'latency-native',
        '2026-10-05T09:00:00.000Z',
        now.toISOString(),
      );
      await tx.query(statements[0]!.sql, statements[0]!.values);
      pending = observe(other, 'latency-run-three', 'latency-native', thirdWindow, 120);
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (
          (
            await fixture.adminDb.query<{ count: number }>(
              'SELECT cardinality(pg_blocking_pids($1))::integer AS count',
              [pid],
            )
          ).rows[0]!.count > 0
        ) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      for (const statement of statements.slice(1)) await tx.query(statement.sql, statement.values);
    });
    await pending;
    expect(
      (
        await db.query(`SELECT 1 FROM ${db.table('monitor_latency_dirty')} WHERE monitor_id = $1`, [
          'latency-native',
        ])
      ).rowCount,
    ).toBe(1);
    await backfillLatencyDay(db, 'latency-native', '2026-10-05');
    const repaired = JSON.parse(
      (
        await db.query<{ payload: string }>(
          `SELECT payload FROM ${db.table('monitor_latency_hourly')} WHERE monitor_id = $1`,
          ['latency-native'],
        )
      ).rows[0]!.payload,
    );
    expect(repaired[0].sampleCount).toBe(3);
    expect(repaired[0].maximum.value).toBe(120);
    expect(
      await buildFullHistoryMonitorSnapshot(db, 'latency-native', { now, staleAfterSeconds: 180 }),
    ).toBeTruthy();
  }, 60_000);

  it('deduplicates concurrent incident evaluation and provider delivery', async () => {
    await monitor('notifications-native');
    await round('notification-run', 'notifications-native');
    await observe(
      db,
      'notification-run',
      'notifications-native',
      '2026-10-05T09:00:00.000Z',
      10,
      false,
    );
    await finalizeRound(db, 'notification-run', now);
    const config = await sealProviderConfig(secret, { botToken: 'test-token', chatId: '123' });
    await db.query(
      `INSERT INTO ${db.table('notification_services')} (id, name, provider, config, updated_at)
      VALUES ('native-service', 'Native', 'telegram', $1, '2026-09-01T00:00:00.000Z')`,
      [config],
    );
    await db.query(
      `INSERT INTO ${db.table('monitor_notification_services')} (monitor_id, notification_service_id) VALUES ('notifications-native', 'native-service')`,
    );
    let sends = 0;
    const dependencies = {
      now,
      enabledRegionIds: ['us-east' as const],
      credentialEncryptionSecret: secret,
      maxAttempts: 8,
      log,
      fetch: (async () => {
        sends += 1;
        return Response.json({ ok: true, result: { message_id: 1, chat: { id: 123 } } });
      }) as typeof fetch,
    };
    await Promise.all([
      processNotifications({ ...dependencies, db, leaseToken: 'one' }),
      processNotifications({ ...dependencies, db: other, leaseToken: 'two' }),
    ]);
    expect(sends).toBe(1);
    const rows = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM ${db.table('notification_deliveries')} WHERE monitor_id = 'notifications-native'`,
    );
    expect(rows.rows).toEqual([{ status: 'sent', attempts: 1 }]);
  }, 60_000);

  it('waits for an observation that encountered an already-existing dirty marker', async () => {
    await monitor('latency-early');
    const firstWindow = '2026-10-05T08:01:00.000Z';
    const secondWindow = '2026-10-05T08:02:00.000Z';
    await round('early-one', 'latency-early', firstWindow);
    await round('early-two', 'latency-early', secondWindow);
    await observe(db, 'early-one', 'latency-early', firstWindow, 10);
    const pid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let rebuilding: Promise<void> | undefined;
    try {
      await db.transaction(async (tx) => {
        await observe(tx, 'early-two', 'latency-early', secondWindow, 100);
        rebuilding = backfillLatencyDay(other, 'latency-early', '2026-10-05');
        let blocked = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (
            (
              await fixture.adminDb.query<{ count: number }>(
                'SELECT cardinality(pg_blocking_pids($1))::integer AS count',
                [pid],
              )
            ).rows[0]!.count > 0
          ) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(
          blocked,
          'dirty upserts must hold their row lock until the observation commits',
        ).toBe(true);
      });
    } finally {
      await rebuilding;
    }
    const payload = JSON.parse(
      (
        await db.query<{ payload: string }>(
          `SELECT payload FROM ${db.table('monitor_latency_hourly')} WHERE monitor_id = 'latency-early'`,
        )
      ).rows[0]!.payload,
    );
    expect(payload[0].sampleCount).toBe(2);
    expect(payload[0].maximum.value).toBe(100);
  }, 30_000);

  it('publishes a native cohort and preserves the report lease', async () => {
    const reports = new FakeR2();
    const token = await claimJob(db, 'reports', new Date(), 120);
    const result = await publishDueReports(
      { db, reports, reportIntervalSeconds: 60, staleAfterSeconds: 180 },
      now,
      log,
      token!,
    );
    expect(result.published).toBe(1);
    expect(reports.store.has(reportCohortPointerKey)).toBe(true);
    const generation = (
      await db.query<{ generation: string }>(
        `SELECT generation FROM ${db.table('report_publications')} WHERE report_key = 'cohort'`,
      )
    ).rows[0]!.generation;
    expect(generation).toBe(String(now.getTime()));
    const normalized = Number(generation);
    expect(Number.isSafeInteger(normalized)).toBe(true);
    expect(normalized).toBe(now.getTime());
    expect((await readJob(db, 'reports'))?.lease_token).toBe(token);
  }, 30_000);

  it('reads native monitor history directly and revokes warm-cache public visibility', async () => {
    await monitor('refresh-native');
    const reports = new FakeR2();
    const env: MonitorReportEnv = {
      DB: db,
      REPORTS: reports,
    };
    const request = new Request(
      'https://reports.example/reports/public/monitors/refresh-native.json',
    );
    expect((await handleMonitorReport(request, env)).status).toBe(200);
    expect(reports.store.size).toBe(0);
    expect(
      (await handleMonitorReport(new Request(request.url, { method: 'HEAD' }), env)).status,
    ).toBe(200);
    await db.query(`UPDATE ${db.table('monitors')} SET is_public = 0 WHERE id = 'refresh-native'`);
    expect((await handleMonitorReport(request, env)).status).toBe(404);
  }, 60_000);

  it('retains unresolved rounds and imported history while deleting bounded finalized rows', async () => {
    await monitor('retention-native');
    await round('retention-pending', 'retention-native', '2026-09-01T00:00:00.000Z');
    const result = await runRetention(
      db,
      now,
      {
        detailedResultsRetentionDays: 7,
        dnsDiagnosticsRetentionDays: 30,
        retentionBatchSize: 1,
        historyRetentionPreserveBefore: '2026-09-01T00:00:00.000Z',
      },
      {},
    );
    expect(result.observationsDeleted).toBeLessThanOrEqual(1);
    expect(
      (await db.query(`SELECT 1 FROM ${db.table('check_runs')} WHERE id = 'retention-pending'`))
        .rowCount,
    ).toBe(1);
  }, 30_000);

  it('runs native recovery and bounded maintenance with persisted statement metrics', async () => {
    const config = parseCoordinatorEnv(
      {
        DB: {} as never,
        WORKERS_URL_DOMAIN: 'example.workers.dev',
        PROBE_SIGNING_SECRET: secret,
        CREDENTIAL_ENCRYPTION_SECRET: secret,
        REGIONS_LIST: 'us-east',
      },
      db,
    );
    const result = await runCoordinatorTick(
      config,
      {
        now: () => now,
        log,
        fetch: (async () => {
          throw new Error('Maintenance must not dispatch probes');
        }) as typeof fetch,
      },
      { maintenanceOnly: true },
    );
    expect(result.metrics.roundsClaimed).toBe(0);
    expect(result.metrics.queryWork.recovery!.statements).toBeGreaterThan(0);
    expect(result.metrics.queryWork.retention!.statements).toBeGreaterThan(0);
    const persisted = JSON.parse((await readJob(db, 'coordinator'))!.state_json!);
    expect(persisted.queryWork.recovery.durationMs).toBeGreaterThan(0);
    expect(persisted.queryWork.recovery).not.toHaveProperty('rowsWritten');
  }, 60_000);

  it('uses native report-job metrics when publication is disabled', async () => {
    const result = await runReportJob(
      { db, reports: new FakeR2(), reportIntervalSeconds: 60, staleAfterSeconds: 180 },
      { now: () => now, log, publicationDisabled: true },
    );
    expect(result.queryWork.reports).toEqual({ statements: 0, durationMs: 0, failures: 0 });
  });

  it('invalidates ordinary observation deletion and safely cascades monitor deletion', async () => {
    await monitor('deletion-native');
    const window = '2026-10-05T07:01:00.000Z';
    await round('deletion-one', 'deletion-native', window);
    const observation = await observe(db, 'deletion-one', 'deletion-native', window, 10);
    await backfillLatencyDay(db, 'deletion-native', '2026-10-05');
    await db.query(`DELETE FROM ${db.table('observations')} WHERE id = $1`, [observation.id]);
    expect(
      (
        await db.query(
          `SELECT 1 FROM ${db.table('monitor_latency_dirty')} WHERE monitor_id = 'deletion-native'`,
        )
      ).rowCount,
    ).toBe(1);
    await backfillLatencyDay(db, 'deletion-native', '2026-10-05');
    expect(
      (
        await db.query(
          `SELECT 1 FROM ${db.table('monitor_latency_hourly')} WHERE monitor_id = 'deletion-native'`,
        )
      ).rowCount,
    ).toBe(0);
    await observe(db, 'deletion-one', 'deletion-native', window, 20);
    await db.query(`DELETE FROM ${db.table('monitors')} WHERE id = 'deletion-native'`);
    for (const table of [
      'observations',
      'check_runs',
      'monitor_latency_dirty',
      'monitor_latency_hourly',
    ]) {
      expect(
        (await db.query(`SELECT 1 FROM ${db.table(table)} WHERE monitor_id = 'deletion-native'`))
          .rowCount,
      ).toBe(0);
    }
  }, 30_000);

  it('completes a correction and rebuild competing across existing hour keys without deadlock', async () => {
    await monitor('correction-native');
    const early = '2026-10-05T05:01:00.000Z';
    const late = '2026-10-05T06:01:00.000Z';
    await round('correction-one', 'correction-native', early);
    await round('correction-two', 'correction-native', late);
    await observe(db, 'correction-one', 'correction-native', early, 10);
    const corrected = await observe(db, 'correction-two', 'correction-native', late, 20);
    const outcomes = await Promise.allSettled([
      db.query(`UPDATE ${db.table('observations')} SET started_at = $1 WHERE id = $2`, [
        early,
        corrected.id,
      ]),
      backfillLatencyDay(other, 'correction-native', '2026-10-05'),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    await backfillLatencyDay(db, 'correction-native', '2026-10-05');
    const payload = JSON.parse(
      (
        await db.query<{ payload: string }>(
          `SELECT payload FROM ${db.table('monitor_latency_hourly')} WHERE monitor_id = 'correction-native'`,
        )
      ).rows[0]!.payload,
    );
    expect(payload[0].sampleCount).toBe(2);
    expect(payload[0].maximum.value).toBe(20);
  }, 30_000);
});
