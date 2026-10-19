import { nowIso, schedulerCapacity } from '@uptime/cloudflare';
import { runCoordinatorTick, type CoordinatorDependencies } from './coordinator.js';
import type { ReportConfig, parseCoordinatorEnv } from './env.js';
import { ReportJobFailure, runReportJob } from './report-job.js';
import { claimJob, reportLeaseSeconds, saveJobState } from './state.js';

export { reportLeaseSeconds } from './state.js';

export const runtimeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function coordinatorRuntimeDependencies(): CoordinatorDependencies {
  return { fetch: runtimeFetch, log: console };
}

export function coordinatorLeaseSeconds(config: {
  readonly enabledRegionIds: readonly unknown[];
  readonly probeConcurrency: number;
}): number {
  const regionCount = Math.max(1, config.enabledRegionIds.length);
  const concurrency = Math.max(1, config.probeConcurrency);
  const taskCount = Math.min(
    schedulerCapacity.regionalTasksPerMinute,
    schedulerCapacity.monitorClaimsPerMinute * regionCount,
  );
  const batchCount = Math.floor((taskCount + 4 * regionCount) / 5);
  const maximumBatchMs = 5 * 30_000 + 15_000;
  const totalWorkMs = taskCount * 30_000 + batchCount * 15_000;
  const dispatchBudget =
    batchCount <= concurrency
      ? maximumBatchMs
      : totalWorkMs / concurrency + (1 - 1 / concurrency) * maximumBatchMs;
  return Math.ceil((dispatchBudget + 30_000) / 1_000);
}

export async function runCoordinatorSchedule(
  config: ReturnType<typeof parseCoordinatorEnv>,
  now = new Date(),
  maintenanceOnly = false,
): Promise<void> {
  const lease = await claimJob(config.db, 'coordinator', now, coordinatorLeaseSeconds(config));
  if (!lease) return;
  try {
    const result = await runCoordinatorTick(config, coordinatorRuntimeDependencies(), {
      publishReports: false,
      maintenanceOnly,
    });
    await saveJobState(config.db, 'coordinator', {
      now: new Date(),
      leaseToken: lease,
      state: result.metrics,
      completed: true,
    });
  } catch (error) {
    const failedAt = new Date();
    await saveJobState(config.db, 'coordinator', {
      now: failedAt,
      leaseToken: lease,
      state: { lastError: 'Coordinator schedule failed', failedAt: nowIso(failedAt) },
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
    await runReportJob(config, { log: console, publicationDisabled: true });
    return;
  }
  const lease = await claimJob(config.db, 'reports', now, reportLeaseSeconds);
  if (!lease) return;
  try {
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
      state: { ...metrics, lastError: 'Report schedule failed', failedAt: nowIso(failedAt) },
    }).catch(() => undefined);
    throw error;
  }
}
