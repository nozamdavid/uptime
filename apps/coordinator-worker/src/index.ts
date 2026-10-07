import {
  budgetEnforcementDisabled,
  nowIso,
  schedulerCapacity,
  schedulingState,
} from '@uptime/cloudflare';
import { pgFirst, resolveRuntimeSource, withPostgresRuntime } from '@uptime/cloudflare/postgres';
import { runCoordinatorTick, type CoordinatorDependencies } from './coordinator.js';
import { parseCoordinatorEnv, type CoordinatorEnv, type ReportConfig } from './env.js';
import { ReportJobFailure, runReportJob } from './report-job.js';
import { claimJob, reportLeaseSeconds, saveJobState } from './state.js';
import {
  budgetAllowsWork,
  configuredBudgetUsage,
  dispatchDueTenants,
  isTenantJob,
  runTenantJob,
} from './tenant-dispatch.js';

export { reportLeaseSeconds } from './state.js';

/** Preserve the receiver required by the Workers runtime's native fetch. */
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

export default {
  async scheduled(_event: ScheduledController, env: CoordinatorEnv): Promise<void> {
    await withPostgresRuntime(env, async (control, catalog) => {
      if (env.LEGACY_IMPORT_COORDINATOR !== 'true') {
        await dispatchDueTenants({ ...env, controlDb: control, catalog });
        return;
      }
      const resolved = await resolveRuntimeSource(
        control,
        catalog,
        env.POSTGRES_SOURCE_DATABASE_ID,
      );
      if (resolved.schedulingPolicy !== 'legacy')
        throw new Error('Legacy coordinator requires an explicit legacy source profile');
      const now = new Date();
      const budgetOff = budgetEnforcementDisabled(env);
      const allowed = await budgetAllowsWork(control, now, configuredBudgetUsage(env), budgetOff);
      const paused = (
        await schedulingState(control, resolved.workspaceId, { ignoreBudget: budgetOff })
      ).paused;
      const workspace = await pgFirst<{ state: string }>(
        control,
        `SELECT state FROM ${control.table('workspaces')} WHERE id = $1`,
        [resolved.workspaceId],
      );
      await control.query(
        `INSERT INTO ${control.table('coordinator_runtime_health')} (workspace_id, source, last_seen_at)
        VALUES ($1, $2, $3) ON CONFLICT (workspace_id) DO UPDATE SET source = excluded.source, last_seen_at = excluded.last_seen_at`,
        [resolved.workspaceId, resolved.source.profile, now.toISOString()],
      );
      const config = {
        ...parseCoordinatorEnv(env, resolved.db),
        schedulingPolicy: 'legacy' as const,
      };
      const maintenanceOnly = !allowed || paused || workspace?.state !== 'active';
      // Await both branches before closing this event's client, including failures.
      const results = await Promise.allSettled([
        runCoordinatorSchedule(config, now, maintenanceOnly),
        runReportSchedule(config, now, maintenanceOnly || config.reportScheduleDisabled),
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
  },

  async fetch(): Promise<Response> {
    return new Response('uptime coordinator', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  },

  async queue(batch: MessageBatch<unknown>, env: CoordinatorEnv): Promise<void> {
    for (const message of batch.messages) {
      if (!isTenantJob(message.body)) {
        console.warn({ event: 'tenant_job_invalid' });
        message.ack();
        continue;
      }
      try {
        // Each message has an independent session and closes before acknowledgement.
        await withPostgresRuntime(env, (control, catalog) =>
          runTenantJob(
            { ...env, controlDb: control, catalog },
            message.body as import('./tenant-dispatch.js').TenantJob,
          ),
        );
        message.ack();
      } catch {
        console.error({ event: 'tenant_job_failed', workspaceId: message.body.workspaceId });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<CoordinatorEnv>;

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
