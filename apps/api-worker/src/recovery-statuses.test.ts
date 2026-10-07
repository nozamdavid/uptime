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

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close();
});

async function addObservation(
  ctx: TestContext,
  monitorId: string,
  minute: number,
  options: { success?: boolean; runStatus?: 'pending' | 'complete' | 'partial' } = {},
) {
  const window = `2026-09-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const success = options.success ?? true;
  const run = await seedRun(ctx.db, {
    monitorId,
    status: options.runStatus ?? 'complete',
    windowStartedAt: window,
  });
  await seedObservation(ctx.db, {
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
    await ctx.db.query('SET LOCAL enable_seqscan = off');
    const failedPlan = await ctx.db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT o.scheduled_window FROM ${ctx.db.table('observations')} o
       WHERE o.monitor_id = $1 AND o.region_id = $2
         AND o.scheduled_window >= $3 AND o.success = 0
         AND EXISTS (SELECT 1 FROM ${ctx.db.table('check_runs')} cr
           WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
       ORDER BY o.scheduled_window DESC LIMIT 1`,
      ['monitor', 'us-east', '2026-09-16T00:00:00.000Z'],
    );
    const recentPlan = await ctx.db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT o.success FROM ${ctx.db.table('observations')} o
       WHERE o.monitor_id = $1 AND o.region_id = $2 AND o.scheduled_window > $3
         AND EXISTS (SELECT 1 FROM ${ctx.db.table('check_runs')} cr
           WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
       ORDER BY o.scheduled_window DESC LIMIT 5`,
      ['monitor', 'us-east', '2026-09-16T10:00:00.000Z'],
    );
    const detail = (rows: { 'QUERY PLAN': string }[]) =>
      rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(detail(failedPlan.rows)).toContain('observations_failed_run_region_idx');
    expect(detail(recentPlan.rows)).toContain('observations_monitor_region_window_unique');
    expect(detail(recentPlan.rows)).not.toContain('Sort');
  });

  it('derives recovery from finalized observations after the latest failure', async () => {
    const ctx = await context();
    const monitorId = await seedMonitor(ctx.db);

    // Earlier observations, including those before today, cannot affect the
    // consecutive-success run after today's latest failure.
    const oldRun = await seedRun(ctx.db, {
      monitorId,
      status: 'complete',
      windowStartedAt: '2026-09-15T23:59:00.000Z',
    });
    await seedObservation(ctx.db, {
      checkRunId: oldRun,
      monitorId,
      scheduledWindow: '2026-09-15T23:59:00.000Z',
      startedAt: '2026-09-15T23:59:05.000Z',
    });
    await addObservation(ctx, monitorId, 0, { success: false });
    await addObservation(ctx, monitorId, 1);
    await addObservation(ctx, monitorId, 2);

    const details = await monitorUptimeDetailsBulk(ctx.db, [monitorId], currentTime);
    expect(details.get(monitorId)).toMatchObject({
      uptime: { recoveryStatus: 'recovering' },
      affectedRegionIds: [],
    });

    await addObservation(ctx, monitorId, 3);
    await addObservation(ctx, monitorId, 4);
    await addObservation(ctx, monitorId, 5);
    const recovered = await monitorUptimeDetailsBulk(ctx.db, [monitorId], currentTime);
    expect(recovered.get(monitorId)?.uptime.recoveryStatus).toBe('up');
  });

  it('ignores observations belonging to pending runs', async () => {
    const ctx = await context();
    const monitorId = await seedMonitor(ctx.db);
    await addObservation(ctx, monitorId, 0, { success: false });
    for (let minute = 1; minute <= 5; minute += 1) {
      await addObservation(ctx, monitorId, minute, { runStatus: 'pending' });
    }
    await addObservation(ctx, monitorId, 6);

    const details = await monitorUptimeDetailsBulk(ctx.db, [monitorId], currentTime);
    expect(details.get(monitorId)).toMatchObject({
      uptime: { recoveryStatus: 'down' },
      affectedRegionIds: ['us-east'],
    });
  });
});
