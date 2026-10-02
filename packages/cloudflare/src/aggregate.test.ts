import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './testing/sqlite.js';

function setup() {
  const db = createTestDatabase();
  db.prepare(
    `INSERT INTO monitors (id, url, interval_seconds, timeout_ms, next_check_at)
     VALUES ('m1', 'https://example.com', 60, 1000, '2026-09-20T10:00:00.000Z')`,
  ).run();
  return db;
}

function insertRun(
  db: ReturnType<typeof setup>,
  id: string,
  window: string,
  status: 'pending' | 'complete' | 'partial' = 'pending',
) {
  db.prepare(
    `INSERT INTO check_runs (id, monitor_id, window_started_at, status, expected_region_count,
      monitor_url, timeout_ms, deadline_at)
     VALUES (?, 'm1', ?, ?, 2, 'https://example.com', 1000, ?)`,
  ).run(id, window, status, new Date(Date.parse(window) + 16_000).toISOString());
}

function observe(
  db: ReturnType<typeof setup>,
  id: string,
  runId: string,
  region: string,
  window: string,
  success: boolean,
  responseMs: number | null,
) {
  db.prepare(
    `INSERT INTO observations (id, check_run_id, monitor_id, region_id, scheduled_window, status,
      success, http_status, response_ms, error_code, started_at)
     VALUES (?, ?, 'm1', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    runId,
    region,
    window,
    success ? 'success' : 'http_failure',
    success ? 1 : 0,
    success ? 200 : 500,
    responseMs,
    success ? null : 'timeout',
    new Date(Date.parse(window) + 1_000).toISOString(),
  );
}

function aggregate(db: ReturnType<typeof setup>) {
  return db
    .prepare(
      `SELECT received_count, success_count, uptime_percentage, average_response_ms,
        response_sum_ms, response_count_ms, weight, source
       FROM monitor_daily_uptime WHERE monitor_id = 'm1'
         AND day = '2026-09-20'`,
    )
    .get() as Record<string, number | string>;
}

describe('daily aggregate triggers', () => {
  it('aggregates a finalized round exactly once', () => {
    const db = setup();
    insertRun(db, 'r1', '2026-09-20T10:00:00.000Z');
    observe(db, 'o1', 'r1', 'us-east', '2026-09-20T10:00:00.000Z', true, 100);
    observe(db, 'o2', 'r1', 'eu-west', '2026-09-20T10:00:00.000Z', false, null);
    // Pending rounds are not aggregated yet.
    expect(
      (db.prepare('SELECT count(*) AS c FROM monitor_daily_uptime').get() as { c: number }).c,
    ).toBe(0);
    db.prepare("UPDATE check_runs SET status = 'complete' WHERE id = 'r1'").run();
    expect(aggregate(db)).toMatchObject({
      received_count: 2,
      success_count: 1,
      uptime_percentage: 50,
      average_response_ms: 100,
      response_sum_ms: 100,
      response_count_ms: 1,
      weight: 2,
      source: 'calculated',
    });
    db.close();
  });

  it('does not double count a repeated finalize transition', () => {
    const db = setup();
    insertRun(db, 'r1', '2026-09-20T10:00:00.000Z');
    observe(db, 'o1', 'r1', 'us-east', '2026-09-20T10:00:00.000Z', true, 100);
    db.prepare("UPDATE check_runs SET status = 'complete' WHERE id = 'r1'").run();
    // Idempotent finalize guard: status is no longer pending.
    db.prepare(
      "UPDATE check_runs SET status = 'complete' WHERE id = 'r1' AND status = 'pending'",
    ).run();
    expect(aggregate(db)).toMatchObject({ received_count: 1, success_count: 1 });
    db.close();
  });

  it('accumulates a late observation after the round was finalized', () => {
    const db = setup();
    insertRun(db, 'r1', '2026-09-20T10:00:00.000Z');
    observe(db, 'o1', 'r1', 'us-east', '2026-09-20T10:00:00.000Z', true, 100);
    db.prepare("UPDATE check_runs SET status = 'complete' WHERE id = 'r1'").run();
    observe(db, 'o2', 'r1', 'eu-west', '2026-09-20T10:00:00.000Z', true, 300);
    expect(aggregate(db)).toMatchObject({
      received_count: 2,
      success_count: 2,
      uptime_percentage: 100,
      average_response_ms: 200,
    });
    db.close();
  });

  it('combines multiple rounds in the same UTC day using sums rather than averaged averages', () => {
    const db = setup();
    insertRun(db, 'r1', '2026-09-20T10:00:00.000Z');
    observe(db, 'o1', 'r1', 'us-east', '2026-09-20T10:00:00.000Z', true, 100);
    db.prepare("UPDATE check_runs SET status = 'complete' WHERE id = 'r1'").run();

    insertRun(db, 'r2', '2026-09-20T10:01:00.000Z');
    observe(db, 'o2', 'r2', 'us-east', '2026-09-20T10:01:00.000Z', true, 200);
    observe(db, 'o3', 'r2', 'eu-west', '2026-09-20T10:01:00.000Z', false, null);
    db.prepare("UPDATE check_runs SET status = 'partial' WHERE id = 'r2'").run();

    const row = aggregate(db);
    expect(row).toMatchObject({
      received_count: 3,
      success_count: 2,
      average_response_ms: 150,
      response_sum_ms: 300,
      response_count_ms: 2,
      weight: 3,
    });
    expect(row.uptime_percentage as number).toBeCloseTo((2 / 3) * 100, 10);
    db.close();
  });

  it('never overwrites an imported (non-calculated) aggregate row', () => {
    const db = setup();
    db.prepare(
      `INSERT INTO monitor_daily_uptime (monitor_id, day, uptime_percentage, weight, source,
        received_count, success_count, response_sum_ms, response_count_ms)
       VALUES ('m1', '2026-09-20', 99.9, 288, 'status.bsky.app:import', NULL, NULL, 0, 0)`,
    ).run();
    insertRun(db, 'r1', '2026-09-20T10:00:00.000Z');
    observe(db, 'o1', 'r1', 'us-east', '2026-09-20T10:00:00.000Z', true, 100);
    db.prepare("UPDATE check_runs SET status = 'complete' WHERE id = 'r1'").run();
    expect(aggregate(db)).toMatchObject({
      source: 'status.bsky.app:import',
      uptime_percentage: 99.9,
      received_count: null,
    });
    db.close();
  });

  it('keeps aggregates when raw results are deleted for retention', () => {
    const db = setup();
    insertRun(db, 'r1', '2026-09-20T10:00:00.000Z');
    observe(db, 'o1', 'r1', 'us-east', '2026-09-20T10:00:00.000Z', true, 100);
    observe(db, 'o2', 'r1', 'eu-west', '2026-09-20T10:00:00.000Z', false, null);
    db.prepare("UPDATE check_runs SET status = 'complete' WHERE id = 'r1'").run();
    db.prepare('DELETE FROM observations').run();
    expect(aggregate(db)).toMatchObject({ received_count: 2, success_count: 1 });
    db.close();
  });
});
