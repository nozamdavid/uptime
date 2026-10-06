import { all, first, type D1Database } from '@uptime/cloudflare';
import { getPublicMonitor } from '@uptime/api-worker/queries';
import type { WorkflowStep } from 'cloudflare:workers';

import type { ReportEnv } from './env.js';
import { buildFullHistoryMonitorSnapshot } from './full-history.js';
import { meterDatabase } from './query-metrics.js';

export interface MonitorRefreshParams {
  monitorId: string;
  token: string;
  initialInWorkflow?: boolean;
}

export interface MonitorReportEnv extends ReportEnv {
  MONITOR_REFRESH: Workflow<MonitorRefreshParams>;
  MONITOR_SNAPSHOT_FRESH_SECONDS?: string;
  MONITOR_INITIAL_REPORT_WAIT_MS?: string;
}

export type BackgroundTaskScheduler = (task: Promise<unknown>) => void;

interface RefreshState {
  monitor_id: string;
  token: string;
  phase: 'idle' | 'building' | 'starting' | 'active';
  ordinal: number;
  lease_until: string;
  object_key: string | null;
  generated_at: string | null;
}

const leaseSeconds = 180;
const initialReportWaitMs = 20_000;
const initialReportPollMs = 500;
const visibilitySql = `EXISTS (
  SELECT 1 FROM monitors m WHERE m.id = monitor_report_refresh.monitor_id
    AND (m.is_public = 1 OR EXISTS (
      SELECT 1 FROM status_page_monitors spm WHERE spm.monitor_id = m.id
    ))
)`;

function freshnessSeconds(env: MonitorReportEnv): number {
  const value = Number(env.MONITOR_SNAPSHOT_FRESH_SECONDS ?? 120);
  if (!Number.isInteger(value) || value < 1 || value > 86_400)
    throw new Error('MONITOR_SNAPSHOT_FRESH_SECONDS must be an integer from 1 to 86400');
  return value;
}

function leaseUntil(now: Date): string {
  return new Date(now.getTime() + leaseSeconds * 1_000).toISOString();
}

function state(db: D1Database, monitorId: string): Promise<RefreshState | null> {
  return first<RefreshState>(db, 'SELECT * FROM monitor_report_refresh WHERE monitor_id = ?', [
    monitorId,
  ]);
}

/** One atomic claim shared by GET and publication; selection precedes the limit. */
async function claimRefreshes(
  env: MonitorReportEnv,
  monitorIds: readonly string[],
  now: Date,
  incident: boolean,
  limit = 1,
  missingSnapshot = false,
): Promise<RefreshState[]> {
  const candidates = monitorIds.map((monitorId) => ({ monitorId, token: crypto.randomUUID() }));
  return all<RefreshState>(
    env.DB,
    `INSERT INTO monitor_report_refresh (monitor_id, token, phase, ordinal, lease_until)
     SELECT json_extract(candidate.value, '$.monitorId'), json_extract(candidate.value, '$.token'), ?, -1, ?
     FROM json_each(?) candidate
     JOIN monitors m ON m.id = json_extract(candidate.value, '$.monitorId')
     LEFT JOIN monitor_report_refresh current ON current.monitor_id = m.id
     WHERE (m.is_public = 1 OR EXISTS (SELECT 1 FROM status_page_monitors spm WHERE spm.monitor_id = m.id))
       AND (? = 0 OR m.enabled = 1)
       AND (current.monitor_id IS NULL OR current.phase = 'idle' OR current.lease_until <= ?)
       AND (? = 1 OR current.generated_at IS NULL OR current.generated_at < ? OR ? = 1)
     ORDER BY current.generated_at, m.id LIMIT ?
     ON CONFLICT(monitor_id) DO UPDATE SET
       token = excluded.token, phase = excluded.phase, ordinal = -1, lease_until = excluded.lease_until
     WHERE (monitor_report_refresh.phase = 'idle' OR monitor_report_refresh.lease_until <= ?)
       AND (? = 1 OR monitor_report_refresh.generated_at IS NULL OR monitor_report_refresh.generated_at < ? OR ? = 1)
     RETURNING *`,
    [
      'starting',
      leaseUntil(now),
      JSON.stringify(candidates),
      incident ? 1 : 0,
      now.toISOString(),
      incident ? 1 : 0,
      new Date(now.getTime() - freshnessSeconds(env) * 1_000).toISOString(),
      missingSnapshot ? 1 : 0,
      limit,
      now.toISOString(),
      incident ? 1 : 0,
      new Date(now.getTime() - freshnessSeconds(env) * 1_000).toISOString(),
      missingSnapshot ? 1 : 0,
    ],
  );
}

/** Bounded startup only: full-history scans run in the Workflow, never in cron. */
export async function startIncidentMonitorRefreshes(
  env: MonitorReportEnv,
  monitorIds: readonly string[],
  now = new Date(),
  startLimit = 20,
): Promise<void> {
  const limit = Math.max(0, Math.min(20, Math.floor(startLimit)));
  if (!env.MONITOR_REFRESH || monitorIds.length === 0 || limit === 0) return;
  const ids = [...new Set(monitorIds)];
  const pending = await all<RefreshState>(
    env.DB,
    `SELECT refresh.* FROM monitor_report_refresh refresh JOIN monitors m ON m.id = refresh.monitor_id
     WHERE refresh.monitor_id IN (SELECT value FROM json_each(?))
       AND refresh.phase = 'starting' AND refresh.ordinal <= 0 AND m.enabled = 1
     ORDER BY refresh.lease_until, refresh.monitor_id LIMIT ?`,
    [JSON.stringify(ids), limit],
  );
  for (const current of pending) await ensureWorkflow(env, current);
  const remaining = ids.filter((id) => !pending.some((current) => current.monitor_id === id));
  if (remaining.length === 0 || pending.length === limit) return;
  const claimTime = new Date(Math.max(now.getTime(), Date.now()));
  const claimed = await claimRefreshes(env, remaining, claimTime, true, limit - pending.length);
  for (const current of claimed) await ensureWorkflow(env, current);
}

function response(body: string | null, status = 200, head = false): Response {
  return new Response(head ? null : body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(status === 503 ? { 'retry-after': '1' } : {}),
    },
  });
}

/** Read again if a writer replaced and reclaimed the old immutable object. */
async function cachedSnapshot(
  env: MonitorReportEnv,
  current: RefreshState,
): Promise<string | null> {
  if (!current.object_key) return null;
  const object = await env.REPORTS.get(current.object_key);
  if (object) return object.text();
  const latest = await state(env.DB, current.monitor_id);
  if (!latest?.object_key || latest.object_key === current.object_key) return null;
  return (await env.REPORTS.get(latest.object_key))?.text() ?? null;
}

/** Wait briefly for the durable initial Workflow step so GET can return its first report. */
async function waitForInitialSnapshot(
  env: MonitorReportEnv,
  monitorId: string,
): Promise<{ body: string | null; visible: boolean }> {
  const configuredWait = Number(env.MONITOR_INITIAL_REPORT_WAIT_MS ?? initialReportWaitMs);
  const waitMs = Number.isFinite(configuredWait)
    ? Math.max(0, Math.min(initialReportWaitMs, configuredWait))
    : initialReportWaitMs;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await getPublicMonitor(env.DB, monitorId))) return { body: null, visible: false };
    const current = await state(env.DB, monitorId);
    if (current) {
      const body = await cachedSnapshot(env, current);
      if (body && (current.ordinal >= 0 || current.phase === 'idle'))
        return { body, visible: true };
    }
    // A missing row or object must not shorten the cold GET's wait budget.
    const remaining = deadline - Date.now();
    if (remaining > 0)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(initialReportPollMs, remaining)),
      );
  }
  if (!(await getPublicMonitor(env.DB, monitorId))) return { body: null, visible: false };
  const latest = await state(env.DB, monitorId);
  return { body: latest ? await cachedSnapshot(env, latest) : null, visible: true };
}

/** Creation and the first snapshot have separate durable checkpoints. */
async function ensureWorkflow(env: MonitorReportEnv, current: RefreshState): Promise<void> {
  if (!env.MONITOR_REFRESH || current.phase !== 'starting' || current.ordinal > 0) return;
  try {
    // Retry the same instance after uncertain creation; give its initial build a live lease.
    const renewed = await first<RefreshState>(
      env.DB,
      `UPDATE monitor_report_refresh SET lease_until = ?
       WHERE monitor_id = ? AND token = ? AND phase = 'starting' AND ordinal <= 0 RETURNING *`,
      [leaseUntil(new Date()), current.monitor_id, current.token],
    );
    if (!renewed) return;
    try {
      await env.MONITOR_REFRESH.create({
        id: current.token,
        params: {
          monitorId: current.monitor_id,
          token: current.token,
          ...(current.ordinal === -1 ? { initialInWorkflow: true } : {}),
        },
      });
    } catch (error) {
      // A request or an uncertain previous create may already have created it.
      const instance = await env.MONITOR_REFRESH.get(current.token);
      const existing = await instance.status();
      if (
        existing.status === 'errored' ||
        existing.status === 'terminated' ||
        existing.status === 'complete'
      ) {
        await env.DB.prepare(
          `UPDATE monitor_report_refresh SET phase = 'idle', lease_until = ?
           WHERE monitor_id = ? AND token = ? AND phase = 'starting'`,
        )
          .bind(new Date().toISOString(), current.monitor_id, current.token)
          .run();
        throw error;
      }
    }
    await env.DB.prepare(
      `UPDATE monitor_report_refresh SET phase = 'active', lease_until = ?
       WHERE monitor_id = ? AND token = ? AND phase = 'starting' AND ordinal <= 0`,
    )
      .bind(leaseUntil(new Date()), current.monitor_id, current.token)
      .run();
  } catch (error) {
    // The committed initial report remains usable. The next GET retries startup.
    console.error('monitor-refresh-startup', {
      monitorId: current.monitor_id,
      error: String(error),
    });
  }
}

/**
 * Fence both the D1 pointer and object key. An old attempt can finish its R2 put,
 * but cannot replace a newer ordinal or a replacement cycle's committed data.
 */
export async function refreshMonitorSnapshot(
  env: MonitorReportEnv,
  params: MonitorRefreshParams,
  ordinal: number,
  now = new Date(),
): Promise<boolean> {
  const metered = meterDatabase(env.DB);
  metered.setStage('monitor-refresh');
  const started = Date.now();
  const db = metered.db;
  let objectKey: string | null = null;
  let committed = false;
  try {
    const current = await state(db, params.monitorId);
    if (!current || current.token !== params.token) return false;
    if (!(await getPublicMonitor(db, params.monitorId))) return false;
    if (current.ordinal >= ordinal) return true;
    if (current.ordinal !== ordinal - 1 || current.lease_until <= now.toISOString()) return false;
    const snapshot = await buildFullHistoryMonitorSnapshot(db, params.monitorId, {
      now,
      staleAfterSeconds: freshnessSeconds(env),
    });
    if (!snapshot || !(await getPublicMonitor(db, params.monitorId))) return false;
    objectKey = `public/monitor-refresh/${encodeURIComponent(params.monitorId)}/${params.token}/${ordinal}-${crypto.randomUUID()}.json`;
    await env.REPORTS.put(objectKey, JSON.stringify(snapshot), {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    });
    const result = await first<{ object_key: string }>(
      db,
      `UPDATE monitor_report_refresh
       SET object_key = ?, generated_at = ?, ordinal = ?, phase = ?, lease_until = ?
       WHERE monitor_id = ? AND token = ? AND ordinal = ? AND lease_until > ?
         AND ${visibilitySql}
       RETURNING object_key`,
      [
        objectKey,
        snapshot.generatedAt,
        ordinal,
        ordinal === 0 && !params.initialInWorkflow ? 'starting' : ordinal === 4 ? 'idle' : 'active',
        ordinal === 4 ? now.toISOString() : leaseUntil(new Date()),
        params.monitorId,
        params.token,
        ordinal - 1,
        new Date().toISOString(),
      ],
    );
    committed = result !== null;
    if (committed && current.object_key && current.object_key !== objectKey) {
      try {
        await env.REPORTS.delete(current.object_key);
      } catch (error) {
        console.error('monitor-refresh-reclaim', {
          objectKey: current.object_key,
          error: String(error),
        });
      }
    }
    return committed;
  } finally {
    if (objectKey && !committed) {
      try {
        await env.REPORTS.delete(objectKey);
      } catch (error) {
        console.error('monitor-refresh-reclaim', { objectKey, error: String(error) });
      }
    }
    const work = metered.work['monitor-refresh'];
    const metrics = { ...work, durationMs: Date.now() - started, ordinal, committed };
    // Diagnostics must not turn a committed build into a failed Workflow step.
    try {
      if (committed)
        await db
          .prepare(
            `UPDATE monitor_report_refresh SET last_build_metrics = ?
         WHERE monitor_id = ? AND token = ? AND ordinal = ? AND object_key = ?`,
          )
          .bind(JSON.stringify(metrics), params.monitorId, params.token, ordinal, objectKey)
          .run();
    } catch (error) {
      console.error('monitor-refresh-metrics', String(error));
    }
    console.log('monitor-refresh-build', {
      monitorId: params.monitorId,
      ...metrics,
      ...metered.work['monitor-refresh'],
      durationMs: Date.now() - started,
    });
  }
}

export async function runMonitorRefreshCycle(
  env: MonitorReportEnv,
  params: MonitorRefreshParams,
  step: Pick<WorkflowStep, 'do' | 'sleep'>,
): Promise<void> {
  if (params.initialInWorkflow) {
    const built = await step.do(
      'initial',
      { retries: { limit: 2, delay: '10 seconds', backoff: 'constant' }, timeout: '1 minute' },
      () => refreshMonitorSnapshot(env, params, 0),
    );
    if (!built) return;
  }
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    await step.sleep(`wait-${ordinal}`, '1 minute');
    const keepGoing = await step.do(
      `refresh-${ordinal}`,
      { retries: { limit: 2, delay: '10 seconds', backoff: 'constant' }, timeout: '1 minute' },
      () => refreshMonitorSnapshot(env, params, ordinal),
    );
    if (!keepGoing) return;
  }
}

export async function handleMonitorReport(
  request: Request,
  env: MonitorReportEnv,
  scheduleBackground?: BackgroundTaskScheduler,
): Promise<Response> {
  const metered = meterDatabase(env.DB);
  metered.setStage('monitor-request');
  const started = Date.now();
  let status = 500;
  try {
    // Register before the first DB operation, including the atomic claim. A
    // disconnected GET must still finish creating its durable Workflow.
    const work = Promise.resolve().then(() =>
      handleMonitorReportRequest(request, { ...env, DB: metered.db }),
    );
    if (request.method === 'GET' && scheduleBackground) scheduleBackground(work);
    const result = await work;
    status = result.status;
    return result;
  } finally {
    // History scans are metered separately inside the durable Workflow.
    console.log('monitor-refresh-request-work', {
      method: request.method,
      path: new URL(request.url).pathname,
      status,
      ...metered.work['monitor-request'],
      durationMs: Date.now() - started,
    });
  }
}

async function handleMonitorReportRequest(
  request: Request,
  env: MonitorReportEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/reports\/public\/monitors\/([^/]+)\.json$/.exec(url.pathname);
  if (!match) return response(JSON.stringify({ error: 'Not found' }), 404);
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return response(JSON.stringify({ error: 'Method not allowed' }), 405);
  const head = request.method === 'HEAD';
  let reference: string;
  try {
    reference = decodeURIComponent(match[1]!);
  } catch {
    return response(JSON.stringify({ error: 'Not found' }), 404, head);
  }
  const monitor = await getPublicMonitor(env.DB, reference);
  if (!monitor) return response(JSON.stringify({ error: 'Not found' }), 404, head);
  const now = new Date();
  let current = await state(env.DB, monitor.id);
  let cached = current ? await cachedSnapshot(env, current) : null;
  if (head) {
    if (!(await getPublicMonitor(env.DB, monitor.id))) return response(null, 404, true);
    return response(cached, cached ? 200 : 503, true);
  }
  if (
    current?.phase === 'starting' &&
    current.ordinal <= 0 &&
    current.lease_until > now.toISOString()
  ) {
    await ensureWorkflow(env, current);
    current = (await state(env.DB, monitor.id)) ?? current;
    cached = await cachedSnapshot(env, current);
  }
  if (current && cached) {
    const active = current.phase !== 'idle' && current.lease_until > now.toISOString();
    const fresh =
      current.generated_at !== null &&
      now.getTime() - Date.parse(current.generated_at) <= freshnessSeconds(env) * 1_000;
    if ((active && current.ordinal >= 0) || (fresh && current.ordinal >= 0)) {
      if (!(await getPublicMonitor(env.DB, monitor.id))) return response(null, 404);
      return response(cached);
    }
  }

  const [claimed] = await claimRefreshes(env, [monitor.id], now, false, 1, !cached);
  let initialToken: string | null = null;
  if (claimed) {
    if (claimed.ordinal <= 0) initialToken = claimed.token;
    await ensureWorkflow(env, claimed);
  } else {
    // A competing request may have claimed after our initial state read.
    current = await state(env.DB, monitor.id);
    if (current?.ordinal === -1 && current.phase !== 'idle') initialToken = current.token;
  }
  if (initialToken || !cached) {
    const waited = await waitForInitialSnapshot(env, monitor.id);
    if (!waited.visible) return response(null, 404);
    if (waited.body) return response(waited.body);
    return response(JSON.stringify({ error: 'Report refresh in progress' }), 503);
  }
  if (!(await getPublicMonitor(env.DB, monitor.id))) return response(null, 404);
  current = await state(env.DB, monitor.id);
  const body = current ? await cachedSnapshot(env, current) : null;
  return body
    ? response(body)
    : response(JSON.stringify({ error: 'Report refresh in progress' }), 503);
}
