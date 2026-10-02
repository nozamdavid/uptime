import { flushUsage, meterDatabase, nowIso, type D1Database } from '@uptime/cloudflare';

import { runCoordinatorTick, type CoordinatorDependencies } from './coordinator.js';
import { parseCoordinatorEnv, type CoordinatorEnv, type ReportConfig } from './env.js';
import { ReportJobFailure, runReportJob } from './report-job.js';
import { claimJob, reportLeaseSeconds, saveJobState } from './state.js';
import { dispatchDueTenants, runTenantJob, type TenantJob } from './tenant-dispatch.js';

export { reportLeaseSeconds } from './state.js';

/** Preserve the receiver required by the Workers runtime's native fetch. */
export const runtimeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function coordinatorRuntimeDependencies(): CoordinatorDependencies {
  // Omit `now` so queued batches sample the live clock when they are dispatched.
  return { fetch: runtimeFetch, log: console };
}

const regionalTaskBudget = 108;
const configuredMonitorLimit = 50;
const maximumMonitorTimeoutMs = 30_000;
const leaseCompletionMarginMs = 30_000;

export function coordinatorLeaseSeconds(config: {
  readonly enabledRegionIds: readonly unknown[];
  readonly probeConcurrency: number;
}): number {
  const regionCount = Math.max(1, config.enabledRegionIds.length);
  const concurrency = Math.max(1, config.probeConcurrency);
  const taskCount = Math.min(regionalTaskBudget, configuredMonitorLimit * regionCount);
  // A region batch has at most five 30-second probes plus 15 seconds of batch
  // overhead. For uneven region membership, list scheduling finishes within
  // totalWork / concurrency + (1 - 1 / concurrency) * largestBatch.
  const batchCount = Math.floor((taskCount + 4 * regionCount) / 5);
  const maximumBatchMs = 5 * maximumMonitorTimeoutMs + 15_000;
  const totalWorkMs = taskCount * maximumMonitorTimeoutMs + batchCount * 15_000;
  const dispatchBudget =
    batchCount <= concurrency
      ? maximumBatchMs
      : totalWorkMs / concurrency + (1 - 1 / concurrency) * maximumBatchMs;
  return Math.ceil((dispatchBudget + leaseCompletionMarginMs) / 1_000);
}

/**
 * Cloudflare coordinator Worker entry point.
 *
 * `scheduled` runs every minute. Overlapping invocations are bounded by the
 * `coordinator` and `reports` leases isolate probe work from snapshot
 * publication. A live coordinator lease therefore cannot suppress the next
 * minute's report attempt. All work is idempotent if a lease expires mid-tick,
 * so a crashed invocation is recovered by a later one.
 */
export default {
  async scheduled(_event: ScheduledController, env: CoordinatorEnv): Promise<void> {
    if (env.CONTROL_DB) {
      const rawControl = env.CONTROL_DB;
      const controlMeter = meterDatabase(rawControl);
      try {
        await dispatchDueTenants({ ...env, CONTROL_DB: controlMeter.db } as CoordinatorEnv & {
          CONTROL_DB: D1Database;
        });
      } finally {
        await flushUsage(rawControl, '__control__', controlMeter.usage).catch((error) => {
          console.warn({ event: 'control_usage_flush_failed', error: String(error) });
        });
      }
      return;
    }
    const config = parseCoordinatorEnv(env);
    const results = await Promise.allSettled([
      runCoordinatorSchedule(config),
      runReportSchedule(config, new Date(), config.reportScheduleDisabled),
    ]);
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        console.error({
          event: index === 0 ? 'coordinator_schedule_failed' : 'report_schedule_failed',
          error: String(result.reason),
        });
      }
    }
  },

  async fetch(): Promise<Response> {
    return new Response('uptime coordinator', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  },

  async queue(batch: MessageBatch<unknown>, env: CoordinatorEnv): Promise<void> {
    if (!env.CONTROL_DB) return;
    const rawControl = env.CONTROL_DB;
    const controlMeter = meterDatabase(rawControl);
    try {
      for (const message of batch.messages) {
        const job = message.body as TenantJob;
        if (
          !job ||
          typeof job.workspaceId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            job.workspaceId,
          ) ||
          typeof job.scheduledAt !== 'string' ||
          !Number.isFinite(Date.parse(job.scheduledAt))
        ) {
          console.warn({ event: 'tenant_job_invalid' });
          message.ack();
          continue;
        }
        try {
          await runTenantJob(
            { ...env, CONTROL_DB: controlMeter.db } as CoordinatorEnv & { CONTROL_DB: D1Database },
            job,
          );
          message.ack();
        } catch (error) {
          console.error({
            event: 'tenant_job_failed',
            workspaceId: job.workspaceId,
            error: String(error),
          });
          message.retry();
        }
      }
    } finally {
      await flushUsage(rawControl, '__control__', controlMeter.usage).catch((error) => {
        console.warn({ event: 'control_usage_flush_failed', error: String(error) });
      });
    }
  },
} satisfies ExportedHandler<CoordinatorEnv>;

export async function runCoordinatorSchedule(
  config: ReturnType<typeof parseCoordinatorEnv>,
  now = new Date(),
): Promise<void> {
  // Cover the worst queued probe workload plus persistence. Fast ticks still
  // release immediately through saveJobState.
  const lease = await claimJob(config.db, 'coordinator', now, coordinatorLeaseSeconds(config));
  if (!lease) return;
  try {
    const result = await runCoordinatorTick(config, coordinatorRuntimeDependencies(), {
      publishReports: false,
    });
    const completedAt = new Date();
    await saveJobState(config.db, 'coordinator', {
      now: completedAt,
      leaseToken: lease,
      state: result.metrics,
      completed: true,
    });
  } catch (error) {
    const failedAt = new Date();
    await saveJobState(config.db, 'coordinator', {
      now: failedAt,
      leaseToken: lease,
      state: { lastError: String(error), failedAt: nowIso(failedAt) },
    }).catch(() => undefined);
    throw error;
  }
}

export async function runReportSchedule(
  config: ReportConfig,
  now = new Date(),
  publicationDisabled = false,
): Promise<void> {
  if (publicationDisabled) {
    // A separate reporter owns the reports lease and metrics. Maintenance
    // fences live leases in SQL without competing for its scheduling slot.
    await runReportJob(config, { log: console, publicationDisabled: true });
    return;
  }
  const lease = await claimJob(config.db, 'reports', now, reportLeaseSeconds);
  if (!lease) return;
  try {
    // Sample again after lease acquisition so generatedAt reflects publication time.
    const metrics = await runReportJob(config, {
      log: console,
      jobLeaseToken: lease,
      publicationDisabled,
    });
    await saveJobState(config.db, 'reports', {
      now: new Date(),
      leaseToken: lease,
      state: metrics,
      completed: true,
    });
    console.log({ event: 'report_metrics', ...metrics });
  } catch (error) {
    const failedAt = new Date();
    const metrics = error instanceof ReportJobFailure ? error.metrics : undefined;
    await saveJobState(config.db, 'reports', {
      now: failedAt,
      leaseToken: lease,
      state: { ...metrics, lastError: String(error), failedAt: nowIso(failedAt) },
    }).catch(() => undefined);
    throw error;
  }
}
