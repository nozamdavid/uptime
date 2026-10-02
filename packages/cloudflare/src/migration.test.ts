import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './testing/sqlite.js';

function monitorValues(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/health',
    interval_seconds: 60,
    timeout_ms: 1_000,
    next_check_at: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

function insertMonitor(
  db: ReturnType<typeof createTestDatabase>,
  overrides: Record<string, unknown> = {},
): string {
  const values = monitorValues(overrides);
  const keys = Object.keys(values);
  const row = db
    .prepare(
      `INSERT INTO monitors (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`,
    )
    .get(...(Object.values(values) as never[])) as { id: string };
  return row.id;
}

describe('D1 initial migration', () => {
  it('validates badge colors without exceeding the D1 GLOB pattern limit', () => {
    const db = createTestDatabase();
    db.prepare('INSERT INTO badges (name, color) VALUES (?, ?)').run('Valid', '#a1B2c3');
    expect(() =>
      db.prepare('INSERT INTO badges (name, color) VALUES (?, ?)').run('Invalid', '#12xyz9'),
    ).toThrow();
    const schema = (
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'badges'")
        .get() as { sql: string }
    ).sql;
    const patterns = [...schema.matchAll(/GLOB\s+'([^']+)'/g)].map((match) => match[1]!);
    expect(Math.max(...patterns.map((pattern) => Buffer.byteLength(pattern)))).toBeLessThanOrEqual(
      50,
    );
    db.close();
  });

  it('preserves populated monitor badge links while replacing the constraint', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const migration of migrations.filter((name) => !name.startsWith('0006_'))) {
      db.exec(readFileSync(`${directory}/${migration}`, 'utf8'));
    }
    db.exec("INSERT INTO badges (id,name,color) VALUES ('badge','Badge','#a1b2c3')");
    const monitorId = insertMonitor(db, { badge_id: 'badge' });
    db.exec(
      readFileSync(`${directory}/${migrations.find((name) => name.startsWith('0006_'))!}`, 'utf8'),
    );
    expect(db.prepare('SELECT badge_id FROM monitors WHERE id=?').get(monitorId)).toEqual({
      badge_id: 'badge',
    });
    db.close();
  });

  it('widens notification providers and preserves dependent D1 rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const blueskyMigration = migrations.find((name) => name.startsWith('0011_'))!;
    for (const migration of migrations.filter((name) => name !== blueskyMigration)) {
      db.exec(readFileSync(`${directory}/${migration}`, 'utf8'));
    }

    const monitorId = insertMonitor(db);
    db.prepare(
      `INSERT INTO notification_services (id, name, provider, config)
       VALUES ('service-existing', 'Existing', 'webhook', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO monitor_notification_services (monitor_id, notification_service_id)
       VALUES (?, 'service-existing')`,
    ).run(monitorId);
    db.prepare(
      `INSERT INTO notification_deliveries
         (id, monitor_id, notification_service_id, event_key, kind, message, status, attempts,
          next_attempt_at, lease_until, lease_token, last_error)
       VALUES ('delivery-existing', ?, 'service-existing', 'event-existing', 'outage',
          '{"message":"still pending"}', 'pending', 2, '2026-09-20T10:00:00.000Z',
          '2026-09-20T10:01:00.000Z', 'lease-existing', 'temporary failure')`,
    ).run(monitorId);

    db.exec('BEGIN');
    db.exec(readFileSync(`${directory}/${blueskyMigration}`, 'utf8'));
    db.exec('COMMIT');
    const membership = db
      .prepare('SELECT monitor_id, notification_service_id FROM monitor_notification_services')
      .get();
    expect(membership).toEqual({
      monitor_id: monitorId,
      notification_service_id: 'service-existing',
    });
    expect(
      db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get('delivery-existing'),
    ).toMatchObject({
      monitor_id: monitorId,
      notification_service_id: 'service-existing',
      event_key: 'event-existing',
      status: 'pending',
      attempts: 2,
      lease_until: '2026-09-20T10:01:00.000Z',
      lease_token: 'lease-existing',
      last_error: 'temporary failure',
    });
    db.prepare(
      `INSERT INTO notification_services (id, name, provider, config)
       VALUES ('service-bluesky', 'Bluesky', 'bluesky', '{"handle":"ops.example.com"}')`,
    ).run();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('creates every logical entity required by plan.md', () => {
    const db = createTestDatabase();
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'admins',
        'sessions',
        'badges',
        'monitors',
        'monitor_regions',
        'status_pages',
        'status_page_groups',
        'status_page_monitors',
        'check_runs',
        'observations',
        'network_diagnostics',
        'notification_services',
        'monitor_notification_services',
        'monitor_notification_state',
        'notification_deliveries',
        'monitor_daily_uptime',
        'jobs',
        'report_publications',
      ]),
    );
    db.close();
  });

  it('uses bounded retention indexes for each recurring cleanup query', () => {
    const db = createTestDatabase();
    const plans = [
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT cr.id FROM check_runs cr INDEXED BY check_runs_retention_idx
           WHERE cr.created_at < ?
             AND cr.status IN ('complete', 'partial')
             AND cr.finalized_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.check_run_id = cr.id)
           ORDER BY cr.created_at ASC LIMIT ?`,
        )
        .all('2026-09-01T00:00:00.000Z', 100),
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM network_diagnostics INDEXED BY network_diagnostics_retention_idx
           WHERE created_at < ? AND lifecycle <> 'pending'
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all('2026-09-01T00:00:00.000Z', 100),
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM notification_deliveries INDEXED BY notification_deliveries_retention_idx
           WHERE created_at < ? AND status IN ('sent', 'cancelled', 'failed')
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all('2026-09-01T00:00:00.000Z', 100),
    ];
    const details = plans.map((plan) =>
      (plan as { detail: string }[]).map((row) => row.detail).join('\n'),
    );
    expect(details[0]).toContain('check_runs_retention_idx');
    expect(details[0]).toContain('observations_check_run_idx');
    expect(details[1]).toContain('network_diagnostics_retention_idx');
    expect(details[2]).toContain('notification_deliveries_retention_idx');
    db.close();
  });

  it('uses seekable indexes for high-volume API history and recovery queries', () => {
    const db = createTestDatabase();
    const plans = {
      observations: db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM observations
           WHERE monitor_id = ? AND started_at >= ?
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all('monitor', '2026-08-01T00:00:00.000Z', 101),
      regionalObservations: db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM observations
           WHERE monitor_id = ? AND region_id = ? AND started_at >= ?
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all('monitor', 'us-east', '2026-08-01T00:00:00.000Z', 101),
      diagnostics: db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM network_diagnostics
           WHERE monitor_id = ? AND requested_at >= ?
           ORDER BY requested_at DESC, id DESC LIMIT ?`,
        )
        .all('monitor', '2026-08-01T00:00:00.000Z', 101),
      failedRegion: db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 FROM observations o
           WHERE o.monitor_id = ? AND o.region_id = ? AND o.scheduled_window >= ?
             AND o.success = 0
           ORDER BY o.scheduled_window DESC LIMIT 1`,
        )
        .all('monitor', 'us-east', '2026-09-20T00:00:00.000Z'),
      missingUptimeDays: db
        .prepare(
          `EXPLAIN QUERY PLAN
           WITH missing(day) AS (SELECT value FROM json_each(?))
           SELECT missing.day, count(*) FROM missing
           CROSS JOIN check_runs cr INDEXED BY check_runs_monitor_time_idx ON cr.monitor_id = ?
             AND cr.window_started_at >= missing.day || 'T00:00:00.000Z'
             AND cr.window_started_at < strftime('%Y-%m-%dT00:00:00.000Z', missing.day, '+1 day')
           GROUP BY missing.day`,
        )
        .all('["2026-09-20"]', 'monitor'),
    };
    const details = Object.fromEntries(
      Object.entries(plans).map(([name, plan]) => [
        name,
        (plan as { detail: string }[]).map((row) => row.detail).join('\n'),
      ]),
    );
    expect(details.observations).toContain('observations_monitor_started_id_idx');
    expect(details.regionalObservations).toContain('observations_monitor_region_started_id_idx');
    expect(details.diagnostics).toContain('network_diagnostics_monitor_requested_id_idx');
    expect(details.failedRegion).toContain('observations_failed_run_region_idx');
    expect(details.missingUptimeDays).toContain(
      'check_runs_monitor_time_idx (monitor_id=? AND window_started_at>? AND window_started_at<?)',
    );
    for (const [name, detail] of Object.entries(details)) {
      if (name !== 'missingUptimeDays') expect(detail).not.toContain('USE TEMP B-TREE');
    }
    db.close();
  });

  it('keeps coordinator probes off retained notification and observation history', () => {
    const db = createTestDatabase();
    const monitorId = insertMonitor(db);
    db.exec(`WITH RECURSIVE n(i) AS (
      VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 100
    )
    INSERT INTO notification_services (id, name, provider, config)
    SELECT printf('service-%03d', i), printf('History service %03d', i), 'webhook', '{}' FROM n;`);
    // Model roughly three years of terminal delivery history for one monitor.
    // ANALYZE makes the plan assertion sensitive to the history distribution,
    // rather than only to an empty-schema planner choice.
    db.exec(`WITH RECURSIVE n(i) AS (
      VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 10000
    )
    INSERT INTO notification_deliveries (
      id, monitor_id, notification_service_id, event_key, kind, message, status
    )
    SELECT printf('delivery-%05d', i), '${monitorId}', printf('service-%03d', (i % 100) + 1),
      printf('event-%05d', i), 'outage', '{}', 'sent' FROM n;
    ANALYZE;`);
    const activePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT EXISTS (
           SELECT 1 FROM notification_deliveries
           WHERE monitor_id = ? AND status IN ('pending', 'sending')
         ) AS active`,
      )
      .all(monitorId) as { detail: string }[];
    const pendingPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM notification_deliveries
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, created_at LIMIT 10`,
      )
      .all('2026-09-20T10:00:00.000Z') as { detail: string }[];
    const sendingPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM notification_deliveries
         WHERE status = 'sending' AND lease_until < ?
         ORDER BY lease_until, created_at LIMIT 10`,
      )
      .all('2026-09-20T10:00:00.000Z') as { detail: string }[];
    const latencyPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM observations
         WHERE monitor_id = ? AND started_at >= ?
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all('monitor-1', '2026-09-19T10:00:00.000Z', 5_000) as { detail: string }[];

    expect(activePlan.map((row) => row.detail).join('\n')).toContain(
      'notification_deliveries_active_monitor_idx',
    );
    expect(pendingPlan.map((row) => row.detail).join('\n')).toContain(
      'notification_deliveries_pending_due_idx',
    );
    expect(sendingPlan.map((row) => row.detail).join('\n')).toContain(
      'notification_deliveries_sending_lease_idx',
    );
    expect(latencyPlan.map((row) => row.detail).join('\n')).toContain(
      'observations_monitor_started_id_idx',
    );
    expect(latencyPlan.map((row) => row.detail).join('\n')).not.toContain('TEMP B-TREE');

    const foreignKeyPlans = [
      db
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM network_diagnostics WHERE observation_id = ?')
        .all('observation-1'),
      db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT id FROM notification_deliveries WHERE notification_service_id = ?',
        )
        .all('service-001'),
      db.prepare('EXPLAIN QUERY PLAN SELECT id FROM monitors WHERE badge_id = ?').all('badge-1'),
    ] as { detail: string }[][];
    expect(foreignKeyPlans[0]!.map((row) => row.detail).join('\n')).toContain(
      'network_diagnostics_observation_idx',
    );
    expect(foreignKeyPlans[1]!.map((row) => row.detail).join('\n')).toContain(
      'notification_deliveries_service_idx',
    );
    expect(foreignKeyPlans[2]!.map((row) => row.detail).join('\n')).toContain('monitors_badge_idx');
    db.close();
  });

  it('generates uuid primary keys when omitted', () => {
    const db = createTestDatabase();
    const id = insertMonitor(db);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    db.close();
  });

  it('enforces durable result uniqueness on (monitor, region, scheduled window)', () => {
    const db = createTestDatabase();
    const monitorId = insertMonitor(db);
    db.prepare(
      `INSERT INTO check_runs (id, monitor_id, window_started_at, status, expected_region_count,
        monitor_url, timeout_ms, deadline_at)
       VALUES ('run-1', ?, '2026-09-20T10:00:00.000Z', 'pending', 1, 'https://example.com', 1000,
        '2026-09-20T10:00:16.000Z')`,
    ).run(monitorId);
    const observation = db.prepare(
      `INSERT INTO observations (id, check_run_id, monitor_id, region_id, scheduled_window,
        status, success, started_at)
       VALUES (?, 'run-1', ?, 'us-east', '2026-09-20T10:00:00.000Z', 'success', 1, ?)`,
    );
    observation.run('obs-1', monitorId, '2026-09-20T10:00:05.000Z');
    expect(() => observation.run('obs-2', monitorId, '2026-09-20T10:00:06.000Z')).toThrow(
      /UNIQUE constraint failed/,
    );
    // A retry that uses ON CONFLICT DO NOTHING is a no-op.
    const result = db
      .prepare(
        `INSERT INTO observations (id, check_run_id, monitor_id, region_id, scheduled_window,
          status, success, started_at)
         VALUES ('obs-3', 'run-1', ?, 'us-east', '2026-09-20T10:00:00.000Z', 'success', 1, ?)
         ON CONFLICT (monitor_id, region_id, scheduled_window) DO NOTHING`,
      )
      .run(monitorId, '2026-09-20T10:00:07.000Z');
    expect(result.changes).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM observations').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('rejects invalid configuration values at the database boundary', () => {
    const db = createTestDatabase();
    expect(() => insertMonitor(db, { interval_seconds: 61 })).toThrow(/CHECK/);
    expect(() => insertMonitor(db, { timeout_ms: 999 })).toThrow(/CHECK/);
    expect(() => insertMonitor(db, { timeout_ms: 60_000, interval_seconds: 60 })).toThrow(/CHECK/);
    expect(() => insertMonitor(db, { url: 'ftp://example.com' })).toThrow(/CHECK/);
    expect(() => insertMonitor(db, { public_slug: 'Bad Slug' })).toThrow(/CHECK/);
    expect(() => insertMonitor(db, { public_slug: 'ab' })).toThrow(/CHECK/);
    expect(() => insertMonitor(db, { uptime_thresholds: 'not-json' })).toThrow(/CHECK/);
    db.close();
  });

  it('accepts every documented check interval preset', () => {
    const db = createTestDatabase();
    const presets = [
      60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 1_200, 1_500, 1_800,
      2_100, 2_400, 2_700, 3_000, 3_300, 3_600,
    ];
    for (const interval of presets) {
      expect(() =>
        insertMonitor(db, { interval_seconds: interval, timeout_ms: 30_000 }),
      ).not.toThrow();
    }
    db.close();
  });

  it('cascades deletes from monitors through rounds and results', () => {
    const db = createTestDatabase();
    const monitorId = insertMonitor(db);
    db.prepare(
      `INSERT INTO check_runs (id, monitor_id, window_started_at, expected_region_count,
        monitor_url, timeout_ms, deadline_at)
       VALUES ('run-1', ?, '2026-09-20T10:00:00.000Z', 1, 'https://example.com', 1000,
        '2026-09-20T10:00:16.000Z')`,
    ).run(monitorId);
    db.prepare(
      `INSERT INTO observations (id, check_run_id, monitor_id, region_id, scheduled_window,
        status, success, started_at)
       VALUES ('obs-1', 'run-1', ?, 'us-east', '2026-09-20T10:00:00.000Z', 'success', 1, ?)`,
    ).run(monitorId, '2026-09-20T10:00:05.000Z');
    db.prepare('DELETE FROM monitors WHERE id = ?').run(monitorId);
    expect((db.prepare('SELECT count(*) AS c FROM observations').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM check_runs').get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('enforces the single-admin invariant', () => {
    const db = createTestDatabase();
    db.prepare("INSERT INTO admins (email, password_hash) VALUES ('a@example.com', 'hash')").run();
    expect(() =>
      db
        .prepare("INSERT INTO admins (email, password_hash) VALUES ('b@example.com', 'hash')")
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('retains report publication tombstones when their source is deleted', () => {
    const db = createTestDatabase();
    const monitorId = insertMonitor(db, { public_slug: 'example-monitor' });
    db.prepare(
      `INSERT INTO report_publications
         (report_key, kind, monitor_id, object_key, schema_version)
       VALUES ('monitor:example-monitor', 'monitor', ?, 'public/monitors/example-monitor.json', '1')`,
    ).run(monitorId);

    db.prepare('DELETE FROM monitors WHERE id = ?').run(monitorId);
    expect(
      db
        .prepare(
          "SELECT monitor_id, object_key FROM report_publications WHERE report_key = 'monitor:example-monitor'",
        )
        .get(),
    ).toEqual({ monitor_id: null, object_key: 'public/monitors/example-monitor.json' });
    db.close();
  });
});
