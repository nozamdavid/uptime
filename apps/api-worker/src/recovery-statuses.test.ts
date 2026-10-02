import { afterEach, describe, expect, it } from 'vitest';

import { monitorUptimeDetailsBulk } from './queries.js';
import {
  createTestContext,
  seedMonitor,
  seedObservation,
  seedRun,
  type TestContext,
} from './testing/test-utils.js';

const contexts: TestContext[] = [];
const currentTime = new Date('2026-09-16T12:00:00.000Z');

async function context() {
  const ctx = await createTestContext({ now: () => currentTime });
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

function addObservation(
  ctx: TestContext,
  monitorId: string,
  minute: number,
  options: { success?: boolean; runStatus?: 'pending' | 'complete' | 'partial' } = {},
) {
  const window = `2026-09-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const success = options.success ?? true;
  const run = seedRun(ctx.sqlite, {
    monitorId,
    status: options.runStatus ?? 'complete',
    windowStartedAt: window,
  });
  seedObservation(ctx.sqlite, {
    checkRunId: run,
    monitorId,
    scheduledWindow: window,
    success,
    status: success ? 'success' : 'http_failure',
    startedAt: window,
  });
}

describe('recovery status reads', () => {
  it('seeks by the failed-row and scheduled-window indexes', async () => {
    const ctx = await context();
    const failedPlan = ctx.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT o.scheduled_window FROM observations o
         WHERE o.monitor_id = ? AND o.region_id = ?
           AND o.scheduled_window >= ? AND o.success = 0
           AND EXISTS (SELECT 1 FROM check_runs cr
             WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
         ORDER BY o.scheduled_window DESC LIMIT 1`,
      )
      .all('monitor', 'us-east', '2026-09-16T00:00:00.000Z');
    const recentPlan = ctx.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT o.success FROM observations o
         WHERE o.monitor_id = ? AND o.region_id = ? AND o.scheduled_window > ?
           AND EXISTS (SELECT 1 FROM check_runs cr
             WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
         ORDER BY o.scheduled_window DESC LIMIT 5`,
      )
      .all('monitor', 'us-east', '2026-09-16T10:00:00.000Z');
    const detail = (rows: unknown[]) =>
      (rows as { detail: string }[]).map((row) => row.detail).join('\n');

    expect(detail(failedPlan)).toContain('observations_failed_run_region_idx');
    expect(detail(recentPlan)).toContain(
      'sqlite_autoindex_observations_2 (monitor_id=? AND region_id=? AND scheduled_window>?)',
    );
    expect(detail(recentPlan)).not.toContain('USE TEMP B-TREE');
  });

  it('derives recovery from finalized observations after the latest failure', async () => {
    const ctx = await context();
    const monitorId = seedMonitor(ctx.sqlite);

    // Earlier observations, including those before today, cannot affect the
    // consecutive-success run after today's latest failure.
    const oldRun = seedRun(ctx.sqlite, {
      monitorId,
      status: 'complete',
      windowStartedAt: '2026-09-15T23:59:00.000Z',
    });
    seedObservation(ctx.sqlite, {
      checkRunId: oldRun,
      monitorId,
      scheduledWindow: '2026-09-15T23:59:00.000Z',
      startedAt: '2026-09-15T23:59:05.000Z',
    });
    addObservation(ctx, monitorId, 0, { success: false });
    addObservation(ctx, monitorId, 1);
    addObservation(ctx, monitorId, 2);

    const details = await monitorUptimeDetailsBulk(ctx.db, [monitorId], currentTime);
    expect(details.get(monitorId)).toMatchObject({
      uptime: { recoveryStatus: 'recovering' },
      affectedRegionIds: [],
    });

    addObservation(ctx, monitorId, 3);
    addObservation(ctx, monitorId, 4);
    addObservation(ctx, monitorId, 5);
    const recovered = await monitorUptimeDetailsBulk(ctx.db, [monitorId], currentTime);
    expect(recovered.get(monitorId)?.uptime.recoveryStatus).toBe('up');
  });

  it('ignores observations belonging to pending runs', async () => {
    const ctx = await context();
    const monitorId = seedMonitor(ctx.sqlite);
    addObservation(ctx, monitorId, 0, { success: false });
    for (let minute = 1; minute <= 5; minute += 1) {
      addObservation(ctx, monitorId, minute, { runStatus: 'pending' });
    }
    addObservation(ctx, monitorId, 6);

    const details = await monitorUptimeDetailsBulk(ctx.db, [monitorId], currentTime);
    expect(details.get(monitorId)).toMatchObject({
      uptime: { recoveryStatus: 'down' },
      affectedRegionIds: ['us-east'],
    });
  });
});
