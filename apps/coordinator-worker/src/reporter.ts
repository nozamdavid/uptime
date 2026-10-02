import { parseReportEnv, type ReportEnv } from './env.js';
import { runReportSchedule } from './index.js';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  handleMonitorReport,
  runMonitorRefreshCycle,
  type MonitorReportEnv,
  type MonitorRefreshParams,
} from './on-demand-monitor.js';

export class MonitorRefreshWorkflow extends WorkflowEntrypoint<
  MonitorReportEnv,
  MonitorRefreshParams
> {
  override async run(
    event: WorkflowEvent<MonitorRefreshParams>,
    step: WorkflowStep,
  ): Promise<void> {
    await runMonitorRefreshCycle(this.env, event.payload, step);
  }
}

/** Separate scheduled Worker for publication when probe traffic is heavy. */
export default {
  async scheduled(_event: ScheduledController, env: ReportEnv): Promise<void> {
    await runReportSchedule(parseReportEnv(env));
  },

  async fetch(request: Request, env: MonitorReportEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/reports/'))
      return handleMonitorReport(request, env, (task) => ctx.waitUntil(task));
    return new Response('uptime reporter', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
} satisfies ExportedHandler<MonitorReportEnv>;
