import { getPublicMonitor } from '@uptime/api-worker/queries';
import { MonitorRequestCache } from '@uptime/api-worker/monitor-cache';
import type { ReportEnv } from './env.js';
import { buildFullHistoryMonitorSnapshot } from './full-history.js';

/** Retained only so previously deployed Workflow bindings can drain safely. */
export interface MonitorRefreshParams {
  monitorId: string;
  token: string;
  initialInWorkflow?: boolean;
}

export interface MonitorReportEnv extends ReportEnv {
  schedulingPolicy?: 'hosted' | 'legacy';
  workspaceId?: string;
}

const cache = new MonitorRequestCache();

/** The compatibility report URL now reads PostgreSQL, without R2 or Workflows. */
export async function handleMonitorReport(
  request: Request,
  env: MonitorReportEnv,
): Promise<Response> {
  const respond = (body: unknown, status = 200) =>
    new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  const match = /^\/reports\/public\/monitors\/([^/]+)\.json$/.exec(new URL(request.url).pathname);
  if (!match) return respond({ error: 'Not found' }, 404);
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return respond({ error: 'Method not allowed' }, 405);
  let reference: string;
  try {
    reference = decodeURIComponent(match[1]!);
  } catch {
    return respond({ error: 'Not found' }, 404);
  }
  const monitor = await getPublicMonitor(env.DB, reference);
  if (!monitor) return respond({ error: 'Not found' }, 404);
  const body = await cache.get(
    JSON.stringify([
      env.POSTGRES_SOURCE_DATABASE_ID,
      env.workspaceId,
      env.DB.schema,
      monitor.id,
      monitor.updated_at,
    ]),
    () =>
      buildFullHistoryMonitorSnapshot(env.DB, monitor.id, {
        now: new Date(),
        staleAfterSeconds: 60,
      }),
  );
  // Visibility can change while history is being loaded, or while a cache is warm.
  if (!body || !(await getPublicMonitor(env.DB, reference)))
    return respond({ error: 'Not found' }, 404);
  return respond(body);
}
