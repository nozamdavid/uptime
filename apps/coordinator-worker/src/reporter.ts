import { parseReportEnv, type CoordinatorEnv } from './env.js';
import { runReportSchedule } from './index.js';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  handleMonitorReport,
  type MonitorReportEnv,
  type MonitorRefreshParams,
} from './on-demand-monitor.js';
import {
  budgetEnforcementDisabled,
  schedulingState,
  tenantReportsBucket,
  type R2Bucket,
} from '@uptime/cloudflare';
import { pgFirst, resolveRuntimeSource, withPostgresRuntime } from '@uptime/cloudflare/postgres';
import { budgetAllowsWork, configuredBudgetUsage } from './tenant-dispatch.js';

export interface ReporterRuntimeEnv extends CoordinatorEnv {
  REPORTS: R2Bucket;
  MONITOR_REFRESH: Workflow<MonitorRefreshParams>;
}

export async function withReporterDatabase<T>(
  env: ReporterRuntimeEnv,
  callback: (
    session: MonitorReportEnv,
    publicationDisabled: boolean,
    workspaceActive: boolean,
  ) => Promise<T>,
): Promise<T> {
  return withPostgresRuntime(env, async (control, catalog) => {
    const resolved = await resolveRuntimeSource(control, catalog, env.POSTGRES_SOURCE_DATABASE_ID);
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
    const session: MonitorReportEnv = {
      ...env,
      DB: resolved.db,
      workspaceId: resolved.workspaceId,
      schedulingPolicy: resolved.schedulingPolicy,
      REPORTS:
        resolved.schedulingPolicy === 'hosted'
          ? tenantReportsBucket(env.REPORTS, resolved.workspaceId)
          : env.REPORTS,
    };
    const active = workspace?.state === 'active';
    return callback(session, !allowed || paused || !active, active);
  });
}

export class MonitorRefreshWorkflow extends WorkflowEntrypoint<
  ReporterRuntimeEnv,
  MonitorRefreshParams
> {
  override async run(
    event: WorkflowEvent<MonitorRefreshParams>,
    step: WorkflowStep,
  ): Promise<void> {
    // Existing deployed instances complete without generating more monitor reports.
  }
}

/** Separate scheduled Worker for publication when probe traffic is heavy. */
export default {
  async scheduled(_event: ScheduledController, env: ReporterRuntimeEnv): Promise<void> {
    await withReporterDatabase(env, (session, disabled) =>
      runReportSchedule(
        { ...parseReportEnv(session, session.DB), schedulingPolicy: session.schedulingPolicy! },
        new Date(),
        disabled,
      ),
    );
  },

  async fetch(request: Request, env: ReporterRuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/reports/')) {
      // waitUntil owns the whole database open/read/close promise.
      const work = withReporterDatabase(env, (session, _disabled, active) =>
        active
          ? handleMonitorReport(request, session)
          : Promise.resolve(
              new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }),
            ),
      );
      ctx.waitUntil(work);
      return work;
    }
    return new Response('uptime reporter', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
} satisfies ExportedHandler<ReporterRuntimeEnv>;
