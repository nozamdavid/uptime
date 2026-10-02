import {
  all,
  batch,
  first,
  run,
  randomId,
  randomToken,
  resolveWorkspaceDatabase,
  tenantReportsBucket,
  purgeWorkspaceData,
  type CloudflareEnv,
  type D1Database,
  toBoolean,
  isStagingImportedSlot,
  isStagingImportedWorkspace,
  resolveStagingImportedDatabase,
  stagingImportedBindingName,
} from '@uptime/cloudflare';
import { z } from 'zod';
import { createApiRouter, type LogSink } from './app.js';
import { createAtprotoAuth, type AtprotoPrincipal } from './atproto-auth.js';
import { parseApiEnv } from './env.js';
import {
  assertRequestOrigin,
  clientAddress,
  corsHeaders,
  errorResponse,
  HttpErrorLike,
  json,
  readJson,
} from './http.js';
import {
  getPublicMonitor,
  getPublicStatusPage,
  latencyPayload,
  monitorSummary,
  monitorUptimePayload,
  toPublicMonitorSummary,
} from './queries.js';
import { assertPublicHttpUrl, UrlPolicyError } from './security.js';
import { meterDatabase, flushUsage, type MeteredDatabase } from './usage-meter.js';
import { interestList, interestReturnPath, interestSignup, recordInterest } from './interest.js';

export const hostedLimits = {
  monitors: 3,
  regions: 3,
  intervalSeconds: 300,
  statusPages: 1,
  notificationServices: 3,
  rawRetentionDays: 1,
  dailyRetentionDays: 30,
};
type Role = 'owner' | 'maintainer' | 'viewer';
interface Workspace {
  id: string;
  owner_did: string;
  name: string;
  state: string;
  plan: 'free';
  role?: Role;
  last_seen_at: string | null;
}
const log: LogSink = {
  warn: (fields, message) => console.warn(message, fields),
  error: (fields, message) => console.error(message, fields),
};
const router = createApiRouter({ log, notificationFetch: (input, init) => fetch(input, init) });
const didSchema = z
  .string()
  .max(2048)
  .regex(/^did:(plc:[a-z2-7]{24}|web:[A-Za-z0-9._:%-]+)$/);
const uuid = z.uuid();
const mutation = (request: Request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
export const defaultOperatorDid = 'did:plc:lmkzmvv6sdxntwtyxpg7fqqq';

/** Authorize in the control database before selecting any customer data binding. */
export async function hostedFetch(
  request: Request,
  env: CloudflareEnv,
  context: ExecutionContext,
): Promise<Response> {
  const originalControl = env.CONTROL_DB as D1Database;
  const meters = new Map<string, MeteredDatabase>();
  const scopedEnv = { ...env };
  for (const [name, binding] of Object.entries(env)) {
    if (binding && typeof (binding as D1Database).prepare === 'function') {
      const meter = meterDatabase(binding as D1Database);
      meters.set(name, meter);
      scopedEnv[name] = meter.db;
    }
  }
  env = scopedEnv;
  let response: Response;
  let origins: readonly string[] = [];
  try {
    const config = parseApiEnv(env);
    origins = config.allowedOrigins;
    if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
    else {
      assertRequestOrigin(request, origins);
      if (mutation(request)) {
        await assertBodyLimit(request);
        if (request.headers.get('sec-fetch-site') === 'cross-site')
          throw new HttpErrorLike(403, 'origin_forbidden', 'Cross-site requests are not allowed');
      }
      const control = env.CONTROL_DB as D1Database;
      const publicOrigin = requiredString(env.PUBLIC_ORIGIN, 'PUBLIC_ORIGIN');
      const auth = createAtprotoAuth({
        db: control,
        log,
        onLogin: async (principal, returnTo) => {
          if (returnTo === interestReturnPath) await recordInterest(control, principal);
        },
        config: {
          publicOrigin,
          sessionSecret: config.sessionSecret,
          oauthStorageSecret: requiredString(env.OAUTH_STORAGE_SECRET, 'OAUTH_STORAGE_SECRET'),
          sessionTtlSeconds: config.sessionTtlSeconds,
          cookieSecure: new URL(publicOrigin).protocol === 'https:',
          allowLocalHttp: config.environment === 'development',
          successPath: '/app',
          failurePath: toBoolean(env.INTEREST_CHECK_ONLY) ? '/' : '/app',
        },
      });
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/oauth/client-metadata.json' && request.method === 'GET')
        response = auth.metadata();
      else if (path === '/oauth/jwks.json' && request.method === 'GET') response = auth.jwks();
      else if (path === '/health' && request.method === 'GET') response = json({ status: 'ok' });
      else if (path === '/api/auth/atproto/start' && request.method === 'POST') {
        await consumeBudget(control, `login:${clientAddress(request)}`, 5, 600);
        await consumeBudget(control, 'login:global', 1000, 86_400);
        response = await auth.start(request);
        context.waitUntil(auth.prune().catch(() => undefined));
      } else if (path === '/api/auth/atproto/callback' && request.method === 'GET') {
        await consumeBudget(control, `callback:${clientAddress(request)}`, 30, 60);
        await consumeBudget(control, 'callback:global', 1000, 86_400);
        response = await auth.callback(request);
        context.waitUntil(auth.prune().catch(() => undefined));
      } else if (path === '/api/auth/logout' && request.method === 'POST')
        response = await auth.logout(request);
      else if (path === '/api/interest/session' && request.method === 'GET') {
        await consumeBudget(control, `interest:${clientAddress(request)}`, 60, 60);
        await consumeBudget(control, 'public:global', 20_000, 86_400);
        const principal = await auth.principal(request);
        response = json({
          signup: principal ? await interestSignup(control, principal.did) : null,
        });
      } else if (path === '/api/auth/identity' && request.method === 'GET') {
        // This read-only bridge deliberately does not call ensureWorkspace.
        const principal = await auth.principal(request);
        if (!principal) throw new HttpErrorLike(401, 'unauthorized', 'Sign in with AT Protocol');
        const user = await first<{ state: string }>(
          control,
          'SELECT state FROM users WHERE did = ?',
          [principal.did],
        );
        if (user && user.state !== 'active')
          throw new HttpErrorLike(403, 'account_suspended', 'Account is suspended');
        response = json({
          user: { did: principal.did, handle: principal.handle },
          isOperator: operatorDids(env).includes(principal.did),
        });
      } else if (path === '/api/auth/imported-identity' && request.method === 'GET') {
        const principal = await auth.principal(request);
        if (!principal) throw new HttpErrorLike(401, 'unauthorized', 'Sign in with AT Protocol');
        const user = await first<{ state: string }>(
          control,
          'SELECT state FROM users WHERE did=?',
          [principal.did],
        );
        if (user?.state !== 'active')
          throw new HttpErrorLike(403, 'forbidden', 'Imported workspace access denied');
        const workspaceId = uuid.parse(request.headers.get('x-uptime-workspace'));
        const workspace = await accessibleWorkspace(control, principal.did, workspaceId);
        if (workspace.state !== 'active' || !(await isStagingImportedWorkspace(env, workspaceId)))
          throw new HttpErrorLike(403, 'forbidden', 'Imported workspace access denied');
        await resolveStagingImportedDatabase(env, workspaceId);
        response = json({
          user: principal,
          importedWorkspaceId: workspaceId,
          role: workspace.role,
        });
      } else if (
        /^\/api\/(monitors|status-pages)\/public\//.test(path) ||
        path.startsWith('/reports/public/')
      ) {
        if (!['GET', 'HEAD'].includes(request.method))
          throw new HttpErrorLike(405, 'method_not_allowed', 'Read only endpoint');
        await consumeBudget(control, `public:${clientAddress(request)}`, 60, 60);
        await consumeBudget(control, 'public:global', 20_000, 86_400);
        const workspaceId = uuid.parse(url.searchParams.get('workspace'));
        const db = await activeDatabase(env, workspaceId);
        const imported = await isStagingImportedWorkspace(env, workspaceId);
        if (!imported) await enforceHostedRequest(request, db);
        response = path.startsWith('/reports/')
          ? await publicReport(request, env, workspaceId, db)
          : imported
            ? await importedRequest(request, env, workspaceId)
            : await dispatch(request, url, db, config);
        response = await redactPublicUrls(response);
      } else {
        const principal = await auth.principal(request);
        if (!principal) throw new HttpErrorLike(401, 'unauthorized', 'Sign in with AT Protocol');
        await consumeBudget(control, `user:${principal.did}`, 120, 60);
        const user = await first<{ state: string }>(
          control,
          'SELECT state FROM users WHERE did = ?',
          [principal.did],
        );
        if (user && user.state !== 'active')
          throw new HttpErrorLike(403, 'account_suspended', 'Account is suspended');
        const isOperator = operatorDids(env).includes(principal.did);
        if (toBoolean(env.INTEREST_CHECK_ONLY) && !isOperator) {
          const membership = await first(
            control,
            'SELECT workspace_id FROM memberships WHERE did=? LIMIT 1',
            [principal.did],
          );
          if (!membership)
            throw new HttpErrorLike(
              403,
              'product_not_released',
              'Monitoring access has not launched yet. Join the interest list on the home page.',
            );
        }
        if (path.startsWith('/api/operator/')) {
          if (!isOperator) throw new HttpErrorLike(403, 'forbidden', 'Operator access required');
          response = await operatorRequest(request, env, principal);
        } else {
          const workspace = await ensureWorkspace(env, principal);
          const selectedId = request.headers.get('x-uptime-workspace');
          const selected =
            selectedId && selectedId !== workspace.id
              ? await accessibleWorkspace(control, principal.did, uuid.parse(selectedId))
              : { ...workspace, role: 'owner' as Role };
          await run(
            control,
            'UPDATE workspaces SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)',
            [
              new Date().toISOString(),
              selected.id,
              new Date(Date.now() - 15 * 60_000).toISOString(),
            ],
          );
          if (path === '/api/auth/session' && request.method === 'GET') {
            const imported = await isStagingImportedWorkspace(env, selected.id);
            response = json({
              user: principal,
              workspace: {
                id: selected.id,
                name: selected.name,
                state: selected.state,
                plan: 'free',
                ...(imported ? { kind: 'staging_import' } : {}),
              },
              role: selected.role,
              isOperator,
              limits: imported ? null : hostedLimits,
              usage: await workspaceUsage(env, selected),
              budget: await budgetSummary(control),
              workspaces: await all(
                control,
                `SELECT w.id, w.name, w.state, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.did = ? AND w.state <> 'deleted'`,
                [principal.did],
              ),
            });
          } else if (path.startsWith('/api/workspace')) {
            const execute = () => workspaceRequest(request, env, principal, selected);
            response =
              mutation(request) && path.startsWith('/api/workspace/targets')
                ? await withWorkspaceWriteLease(control, selected.id, execute)
                : await execute();
          } else {
            if (selected.state !== 'active')
              throw new HttpErrorLike(
                403,
                'workspace_unavailable',
                'Workspace is waiting for capacity or suspended',
              );
            if (path.startsWith('/api/auth/'))
              throw new HttpErrorLike(404, 'not_found', 'Use AT Protocol login');
            if (mutation(request) && selected.role === 'viewer')
              throw new HttpErrorLike(403, 'forbidden', 'Viewer access is read only');
            await consumeBudget(control, 'private:global', 20_000, 86_400);
            const db = await activeDatabase(env, selected.id);
            const notificationTest = path.match(/^\/api\/notification-services\/([^/]+)\/test$/);
            if (notificationTest && request.method === 'POST') {
              await consumeBudget(control, `notification-tests:${selected.id}`, 10, 86_400);
              await consumeBudget(
                control,
                `notification-test:${selected.id}:${uuid.parse(notificationTest[1])}`,
                3,
                3600,
              );
            }
            const imported = await isStagingImportedWorkspace(env, selected.id);
            if (!imported) await enforceHostedRequest(request, db);
            const execute = () =>
              imported
                ? importedRequest(request, env, selected.id)
                : dispatch(request, url, db, config, principal);
            response = mutation(request)
              ? await withWorkspaceWriteLease(control, selected.id, execute)
              : await execute();
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof HttpErrorLike)
      response = errorResponse(error.status, error.code, error.message);
    else if (error instanceof UrlPolicyError)
      response = errorResponse(400, error.code, error.message);
    else if (error instanceof z.ZodError)
      response = errorResponse(
        400,
        'validation_error',
        error.issues.map((issue) => issue.message).join('; '),
      );
    else if (
      error instanceof Error &&
      /free_(monitor|region|notification|status|policy)_limit/.test(error.message)
    )
      response = errorResponse(409, 'free_limit', 'This operation exceeds the free plan limits');
    else {
      log.error?.({ event: 'hosted_request_failed' }, 'Hosted request failed');
      response = errorResponse(500, 'internal_error', 'Request could not be completed');
    }
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, origins))) headers.set(key, value);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  context.waitUntil(
    (async () => {
      for (const [binding, meter] of meters) {
        if (!meter.usage.rowsRead && !meter.usage.rowsWritten && !meter.usage.storageBytes)
          continue;
        const slot =
          binding === 'CONTROL_DB'
            ? { workspace_id: '__control__' }
            : await first<{ workspace_id: string }>(
                originalControl,
                `SELECT workspace_id FROM tenant_slots WHERE binding_name = ?`,
                [binding],
              );
        if (slot?.workspace_id) await flushUsage(originalControl, slot.workspace_id, meter.usage);
      }
    })().catch(() => log.warn({ event: 'usage_meter_failed' }, 'Usage metering failed')),
  );
  return new Response(response.body, { status: response.status, headers });
}

async function dispatch(
  request: Request,
  url: URL,
  db: D1Database,
  config: ReturnType<typeof parseApiEnv>,
  principal?: AtprotoPrincipal,
) {
  const matched = router.match(request.method as 'GET', url.pathname);
  if (!matched)
    throw new HttpErrorLike(
      router.hasPath(url.pathname) ? 405 : 404,
      'not_found',
      'Endpoint was not found',
    );
  return matched.handler({
    request,
    url,
    params: matched.params,
    env: {
      db,
      config,
      now: () => new Date(),
      log,
      ...(principal ? { principal: { ...principal, id: principal.did } } : {}),
    },
  });
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length < 1) throw new Error(`Missing ${name}`);
  return value;
}

async function importedRequest(
  request: Request,
  env: CloudflareEnv,
  workspaceId: string,
  report = false,
) {
  const binding = env[report ? 'IMPORTED_REPORTER' : 'IMPORTED_API'] as
    { fetch(request: Request): Promise<Response> } | undefined;
  if (env.ENVIRONMENT !== 'staging' || !binding || typeof binding.fetch !== 'function')
    throw new HttpErrorLike(503, 'imported_unavailable', 'Imported staging service is unavailable');
  const url = new URL(request.url);
  url.searchParams.delete('workspace');
  const headers = new Headers(request.headers);
  headers.set('x-uptime-workspace', workspaceId);
  return binding.fetch(new Request(new Request(url, request), { headers, redirect: 'manual' }));
}
async function assertBodyLimit(request: Request) {
  const reject = () => new HttpErrorLike(413, 'body_too_large', 'Request body exceeds 32 KiB');
  if (Number(request.headers.get('content-length') ?? 0) > 32_768) throw reject();
  const reader = request.clone().body?.getReader();
  if (!reader) return;
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 32_768) throw reject();
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
function operatorDids(env: CloudflareEnv) {
  const configured =
    typeof env.OPERATOR_DIDS === 'string'
      ? env.OPERATOR_DIDS.split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  return configured.length > 0 ? configured : [defaultOperatorDid];
}

function minimumAvailableSlots(env: CloudflareEnv) {
  const deployedDefault = env.ENVIRONMENT === 'staging' || env.ENVIRONMENT === 'production' ? 1 : 0;
  const value = Number(env.MIN_AVAILABLE_SLOTS ?? deployedDefault);
  return Number.isInteger(value) && value > 0 ? value : 0;
}
const stagingReservedSlotNames = [
  'STAGING_OPERATOR_DB',
  'STAGING_TEST_DB_001',
  'STAGING_TEST_DB_002',
  stagingImportedBindingName,
] as const;
function isStagingReservedSlot(env: CloudflareEnv, bindingName: string | undefined) {
  return (
    env.ENVIRONMENT === 'staging' &&
    stagingReservedSlotNames.includes(bindingName as (typeof stagingReservedSlotNames)[number])
  );
}
async function activeDatabase(env: CloudflareEnv, id: string) {
  const workspace = await first<Workspace>(
    env.CONTROL_DB as D1Database,
    'SELECT * FROM workspaces WHERE id = ? AND state = ?',
    [id, 'active'],
  );
  if (!workspace) throw new HttpErrorLike(404, 'not_found', 'Workspace was not found');
  if (await isStagingImportedWorkspace(env, id)) return resolveStagingImportedDatabase(env, id);
  return resolveWorkspaceDatabase(env, id);
}
async function accessibleWorkspace(control: D1Database, did: string, id: string) {
  const workspace = await first<Workspace>(
    control,
    `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE w.id = ? AND m.did = ? AND w.state <> 'deleted'`,
    [id, did],
  );
  if (!workspace) throw new HttpErrorLike(403, 'forbidden', 'Workspace access denied');
  return workspace;
}

/** Drain in-flight API writes before deletion, using the same fence as scheduled work. */
async function withWorkspaceWriteLease(
  control: D1Database,
  workspaceId: string,
  execute: () => Promise<Response>,
) {
  const token = randomToken(16);
  const now = new Date();
  const lease = await first(
    control,
    `UPDATE workspaces SET execution_lease_token = ?, execution_lease_until = ?
    WHERE id = ? AND state = 'active' AND (execution_lease_until IS NULL OR execution_lease_until <= ?) RETURNING id`,
    [token, new Date(now.getTime() + 16 * 60_000).toISOString(), workspaceId, now.toISOString()],
  );
  if (!lease)
    throw new HttpErrorLike(
      409,
      'workspace_busy',
      'Workspace is processing another operation. Try again shortly',
    );
  try {
    return await execute();
  } finally {
    await run(
      control,
      'UPDATE workspaces SET execution_lease_token = NULL, execution_lease_until = NULL WHERE id = ? AND execution_lease_token = ?',
      [workspaceId, token],
    );
  }
}

/** Retry an interrupted allocation using its reserved slot. Slots are never reused automatically. */
export async function ensureWorkspace(
  env: CloudflareEnv,
  principal: AtprotoPrincipal,
): Promise<Workspace> {
  const control = env.CONTROL_DB as D1Database;
  const timestamp = new Date().toISOString();
  await run(
    control,
    `INSERT INTO users(did,handle,state,created_at,updated_at,last_seen_at) VALUES(?,?,'active',?,?,?) ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
    [principal.did, principal.handle, timestamp, timestamp, timestamp],
  );
  await run(
    control,
    `INSERT INTO workspaces(id,owner_did,name,state,plan,created_at,updated_at,last_seen_at,next_dispatch_at)
    VALUES(?,?,?,'waiting_for_capacity','free',?,?,?,?) ON CONFLICT(owner_did) DO NOTHING`,
    [
      randomId(),
      principal.did,
      `${principal.handle}'s workspace`,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ],
  );
  const workspace = await first<Workspace>(
    control,
    'SELECT * FROM workspaces WHERE owner_did = ?',
    [principal.did],
  );
  if (!workspace) throw new Error('Workspace provisioning failed');
  if (workspace.state === 'deleted' || workspace.state === 'deleting') return workspace;
  await run(
    control,
    `INSERT INTO memberships(workspace_id,did,role,created_at) VALUES(?,?,'owner',?) ON CONFLICT(workspace_id,did) DO NOTHING`,
    [workspace.id, principal.did, timestamp],
  );
  return provisionWorkspace(env, workspace);
}

async function provisionWorkspace(
  env: CloudflareEnv,
  workspace: Workspace,
  options: { operatorActivation?: boolean; bindingName?: string } = {},
): Promise<Workspace> {
  const control = env.CONTROL_DB as D1Database;
  const timestamp = new Date().toISOString();
  const operatorActivation = options.operatorActivation === true;
  const explicitBinding = typeof options.bindingName === 'string';
  if (workspace.state === 'waiting_for_capacity') {
    const budget = await budgetSummary(control);
    if (
      (operatorActivation || budget.admissionOpen) &&
      budget.forecastUsd < (operatorActivation ? budget.ceilingUsd : 15)
    ) {
      await run(
        control,
        `UPDATE tenant_slots SET workspace_id = ?, status = 'assigned'
        WHERE binding_name = (SELECT s.binding_name FROM tenant_slots s
          WHERE s.status = 'available' AND s.workspace_id IS NULL
          ${explicitBinding ? 'AND s.binding_name = ?' : ''}
          ${!explicitBinding && env.ENVIRONMENT === 'staging' ? `AND s.binding_name NOT IN (${stagingReservedSlotNames.map(() => '?').join(',')})` : ''}
          ${explicitBinding ? '' : 'AND NOT EXISTS (SELECT 1 FROM tenant_slot_controls c WHERE c.binding_name = s.binding_name AND c.admission_enabled = 0)'}
          ORDER BY s.binding_name LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM tenant_slots WHERE workspace_id = ?)
        ${
          explicitBinding && isStagingReservedSlot(env, options.bindingName)
            ? ''
            : `AND (SELECT count(*) FROM tenant_slots s3
          WHERE s3.status = 'assigned'
          ${env.ENVIRONMENT === 'staging' ? `AND s3.binding_name NOT IN (${stagingReservedSlotNames.map(() => '?').join(',')})` : ''}) <
          (SELECT max_workspaces FROM service_controls WHERE id = 1)`
        }
        ${
          explicitBinding
            ? `AND ((COALESCE((SELECT admission_enabled FROM tenant_slot_controls c WHERE c.binding_name = ?),1) = 0 AND
              (SELECT count(*) FROM tenant_slots s2 WHERE s2.status = 'available' AND s2.workspace_id IS NULL
                AND COALESCE((SELECT admission_enabled FROM tenant_slot_controls c2 WHERE c2.binding_name = s2.binding_name),1)=1) >= ${minimumAvailableSlots(env)}) OR
             (COALESCE((SELECT admission_enabled FROM tenant_slot_controls c WHERE c.binding_name = ?),1) = 1 AND
              (SELECT count(*) FROM tenant_slots s2 WHERE s2.status = 'available' AND s2.workspace_id IS NULL
                AND COALESCE((SELECT admission_enabled FROM tenant_slot_controls c2 WHERE c2.binding_name = s2.binding_name),1)=1) > ${minimumAvailableSlots(env)}))`
            : `AND (SELECT count(*) FROM tenant_slots s
          WHERE s.status = 'available' AND s.workspace_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM tenant_slot_controls c WHERE c.binding_name = s.binding_name AND c.admission_enabled = 0))
          > ${minimumAvailableSlots(env)}`
        }`,
        [
          workspace.id,
          ...(explicitBinding ? [options.bindingName!] : []),
          ...(!explicitBinding && env.ENVIRONMENT === 'staging' ? stagingReservedSlotNames : []),
          workspace.id,
          ...(explicitBinding &&
          !isStagingReservedSlot(env, options.bindingName) &&
          env.ENVIRONMENT === 'staging'
            ? stagingReservedSlotNames
            : []),
          ...(!explicitBinding && env.ENVIRONMENT === 'staging' ? stagingReservedSlotNames : []),
          ...(explicitBinding ? [options.bindingName!, options.bindingName!] : []),
        ],
      );
    }
    const slot = await first<{ binding_name: string; database_id: string }>(
      control,
      "SELECT binding_name,database_id FROM tenant_slots WHERE workspace_id = ? AND status = 'assigned'",
      [workspace.id],
    );
    if (slot) {
      const db = env[slot.binding_name] as D1Database | undefined;
      if (!db || typeof db.prepare !== 'function') throw new Error('Tenant binding is unavailable');
      if (isStagingImportedSlot(env, slot.binding_name, slot.database_id)) {
        await run(
          db,
          'INSERT INTO staging_workspace_identity(id,workspace_id,database_id) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING',
          [workspace.id, slot.database_id],
        );
        await resolveStagingImportedDatabase(env, workspace.id);
        await run(
          control,
          "UPDATE workspaces SET state='active',updated_at=? WHERE id=? AND state='waiting_for_capacity'",
          [timestamp, workspace.id],
        );
        workspace.state = 'active';
        return workspace;
      }
      // The identity guard also prevents exposing an incorrectly inventoried database.
      const metadata = await first<{ workspace_id: string }>(
        db,
        'SELECT workspace_id FROM workspace_metadata WHERE id = 1',
      );
      if (metadata && metadata.workspace_id !== workspace.id)
        throw new Error('Tenant identity mismatch');
      if (!metadata) {
        const contents = await first<{ n: number }>(
          db,
          'SELECT (SELECT count(*) FROM monitors) + (SELECT count(*) FROM notification_services) + (SELECT count(*) FROM status_pages) AS n',
        );
        if (contents?.n !== 0) throw new Error('Only empty databases may enter the tenant pool');
        await run(
          db,
          "INSERT INTO workspace_metadata(id,workspace_id,database_id,plan,routing_generation) VALUES(1,?,?,'free',1) ON CONFLICT(id) DO NOTHING",
          [workspace.id, slot.database_id],
        );
        const confirmed = await first<{ workspace_id: string }>(
          db,
          'SELECT workspace_id FROM workspace_metadata WHERE id = 1',
        );
        if (confirmed?.workspace_id !== workspace.id) throw new Error('Tenant identity mismatch');
      }
      await run(
        control,
        "UPDATE workspaces SET state = 'active', updated_at = ? WHERE id = ? AND state = 'waiting_for_capacity'",
        [timestamp, workspace.id],
      );
      workspace.state = 'active';
    }
  }
  return workspace;
}

export async function consumeBudget(
  control: D1Database,
  key: string,
  maximum: number,
  seconds: number,
  now = new Date(),
) {
  const window = new Date(
    Math.floor(now.getTime() / (seconds * 1000)) * seconds * 1000,
  ).toISOString();
  const row = await first<{ count: number }>(
    control,
    `INSERT INTO request_budgets(key,window_started_at,count) VALUES(?,?,1)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_started_at = excluded.window_started_at THEN count + 1 ELSE 1 END,
      window_started_at = excluded.window_started_at
    WHERE window_started_at <> excluded.window_started_at OR count < ? RETURNING count`,
    [key, window, maximum],
  );
  if (!row) throw new HttpErrorLike(429, 'rate_limited', 'Request limit reached. Try again later');
}

export async function budgetSummary(control: D1Database) {
  const settings = await first<{
    monthly_budget_usd: number;
    admission_open: number;
    external_monthly_cost_usd: number;
  }>(control, 'SELECT * FROM service_controls WHERE id = 1');
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const usage = await first<{
    reads: number;
    writes: number;
    storage: number;
    first_day: string | null;
  }>(
    control,
    `SELECT COALESCE(SUM(rows_read),0) AS reads, COALESCE(SUM(rows_written),0) AS writes, MIN(day) AS first_day,
      (SELECT COALESCE(SUM(bytes),0) FROM (SELECT MAX(storage_bytes) AS bytes FROM workspace_usage_daily GROUP BY workspace_id)) AS storage
      FROM workspace_usage_daily WHERE day >= ?`,
    [since],
  );
  const factor =
    31 /
    Math.max(
      1,
      Math.min(
        31,
        usage?.first_day
          ? Math.floor((now.getTime() - Date.parse(usage.first_day)) / 86_400_000) + 1
          : 1,
      ),
    );
  const forecastUsd =
    5 +
    Number(settings?.external_monthly_cost_usd ?? 0) +
    (Math.max(0, Number(usage?.reads ?? 0) * factor - 25_000_000_000) / 1_000_000) * 0.001 +
    Math.max(0, Number(usage?.writes ?? 0) * factor - 50_000_000) / 1_000_000 +
    Math.max(0, Number(usage?.storage ?? 0) / 1_000_000_000 - 5) * 0.75;
  return {
    ceilingUsd: Math.min(20, Number(settings?.monthly_budget_usd ?? 20)),
    baseUsd: 5,
    externalMonthlyCostUsd: Number(settings?.external_monthly_cost_usd ?? 0),
    forecastUsd: Math.round(forecastUsd * 100) / 100,
    admissionOpen: settings?.admission_open === 1 && forecastUsd < 15,
    billingWindow: 'rolling_31_days',
    coverage:
      'Measured D1 API, control and coordinator work over a rolling 31-day window, plus manually entered other costs. Workers CPU, queues, R2 and provider billing need Cloudflare alerts.',
  };
}

async function workspaceUsage(env: CloudflareEnv, workspace: Workspace) {
  if (!['active', 'suspended'].includes(workspace.state))
    return { monitors: 0, statusPages: 0, notificationServices: 0 };
  const db = (await isStagingImportedWorkspace(env, workspace.id))
    ? await resolveStagingImportedDatabase(env, workspace.id)
    : await resolveWorkspaceDatabase(env, workspace.id);
  return await first<{ monitors: number; statusPages: number; notificationServices: number }>(
    db,
    `SELECT (SELECT count(*) FROM monitors) AS monitors, (SELECT count(*) FROM status_pages) AS statusPages, (SELECT count(*) FROM notification_services) AS notificationServices`,
  );
}

async function slotInventory(env: CloudflareEnv) {
  const control = env.CONTROL_DB as D1Database;
  const rows = await all<{
    binding_name: string;
    database_id: string;
    status: 'available' | 'assigned' | 'deleting';
    workspace_id: string | null;
    owner_handle: string | null;
    admission_enabled: number;
  }>(
    control,
    `SELECT s.*, u.handle AS owner_handle, COALESCE(c.admission_enabled,1) AS admission_enabled
    FROM tenant_slots s LEFT JOIN tenant_slot_controls c ON c.binding_name=s.binding_name
    LEFT JOIN workspaces w ON w.id=s.workspace_id LEFT JOIN users u ON u.did=w.owner_did
    ORDER BY s.binding_name`,
  );
  const configured = rows.filter((slot) => {
    const binding = env[slot.binding_name] as D1Database | undefined;
    return binding && typeof binding.prepare === 'function';
  });
  const settings = await first<{ max_workspaces: number }>(
    control,
    'SELECT max_workspaces FROM service_controls WHERE id=1',
  );
  return {
    maxWorkspaces: settings?.max_workspaces ?? 10,
    configuredSlots: configured.length,
    assignedSlots: rows.filter((slot) => slot.status === 'assigned').length,
    availableSlots: configured.filter(
      (slot) => slot.status === 'available' && !slot.workspace_id && slot.admission_enabled === 1,
    ).length,
    heldSlots: rows.filter((slot) => slot.status === 'available' && slot.admission_enabled === 0)
      .length,
    quarantinedSlots: rows.filter((slot) => slot.status === 'deleting').length,
    slots: rows.map((slot) => ({
      bindingName: slot.binding_name,
      databaseId: slot.database_id,
      status: slot.status,
      admissionEnabled: slot.admission_enabled === 1,
      workspaceId: slot.workspace_id,
      ownerHandle: slot.owner_handle,
      ...(isStagingImportedSlot(env, slot.binding_name, slot.database_id)
        ? { kind: 'staging_import' }
        : {}),
    })),
  };
}

async function operatorRequest(request: Request, env: CloudflareEnv, principal: AtprotoPrincipal) {
  const control = env.CONTROL_DB as D1Database;
  const path = new URL(request.url).pathname;
  if (path === '/api/operator/interest' && request.method === 'GET')
    return json(await interestList(control));
  if (path === '/api/operator/slots' && request.method === 'GET')
    return json(await slotInventory(env));
  if (path === '/api/operator/slots' && request.method === 'PATCH') {
    const inventory = await slotInventory(env);
    const input = z
      .object({
        maxWorkspaces: z.number().int().min(1).max(10),
      })
      .parse(await readJson(request));
    await run(control, 'UPDATE service_controls SET max_workspaces=? WHERE id=1', [
      input.maxWorkspaces,
    ]);
    await audit(control, null, principal.did, 'workspace_capacity', input);
    return json(await slotInventory(env));
  }
  const slotAssignment = path.match(/^\/api\/operator\/slots\/([A-Z][A-Z0-9_]{0,63})\/assignment$/);
  if (slotAssignment && request.method === 'POST') {
    const bindingName = slotAssignment[1]!;
    const input = z.object({ ownerDid: didSchema }).parse(await readJson(request));
    const binding = env[bindingName] as D1Database | undefined;
    if (!binding || typeof binding.prepare !== 'function')
      throw new HttpErrorLike(409, 'slot_unavailable', 'Slot is not bound to this deployment');
    const slot = await first<{
      binding_name: string;
      status: 'available' | 'assigned' | 'deleting';
      workspace_id: string | null;
    }>(control, 'SELECT binding_name,status,workspace_id FROM tenant_slots WHERE binding_name=?', [
      bindingName,
    ]);
    if (!slot)
      throw new HttpErrorLike(409, 'slot_unavailable', 'Only an unused slot can be assigned');

    const user = await first<{ did: string; handle: string; state: string }>(
      control,
      'SELECT did,handle,state FROM users WHERE did=?',
      [input.ownerDid],
    );
    const interest = await first<{ did: string; handle: string }>(
      control,
      'SELECT did,handle FROM interest_signups WHERE did=?',
      [input.ownerDid],
    );
    if (user && user.state !== 'active')
      throw new HttpErrorLike(409, 'user_unavailable', 'The selected user is not active');
    const ownerHandle = user?.handle ?? interest?.handle;
    if (!ownerHandle)
      throw new HttpErrorLike(
        404,
        'interest_signup_not_found',
        'The selected user has not joined the interest list',
      );

    const existing = await first<Workspace>(control, 'SELECT * FROM workspaces WHERE owner_did=?', [
      input.ownerDid,
    ]);
    if (slot.status !== 'available') {
      if (slot.status === 'assigned' && slot.workspace_id === existing?.id) {
        if (existing.state === 'waiting_for_capacity') {
          const repaired = await provisionWorkspace(env, existing, {
            operatorActivation: true,
            bindingName,
          });
          if (repaired.state !== 'active')
            throw new HttpErrorLike(409, 'capacity_unavailable', 'The assigned slot is not ready');
          return json({
            workspaceId: repaired.id,
            state: repaired.state,
            bindingName,
            ownerDid: input.ownerDid,
            ownerHandle,
          });
        }
        if (existing.state === 'active')
          return json({
            workspaceId: existing.id,
            state: existing.state,
            bindingName,
            ownerDid: input.ownerDid,
            ownerHandle,
          });
      }
      throw new HttpErrorLike(409, 'slot_unavailable', 'Only an unused slot can be assigned');
    }
    if (existing?.state === 'deleted' || existing?.state === 'deleting')
      throw new HttpErrorLike(
        409,
        'workspace_unavailable',
        'The selected user has a deleted workspace',
      );
    if (existing) {
      const assigned = await first<{ binding_name: string }>(
        control,
        "SELECT binding_name FROM tenant_slots WHERE workspace_id=? AND status='assigned'",
        [existing.id],
      );
      if (assigned && assigned.binding_name !== bindingName)
        throw new HttpErrorLike(
          409,
          'workspace_already_assigned',
          'The selected user already has another slot',
        );
      if (assigned && existing.state === 'active')
        return json({
          workspaceId: existing.id,
          state: existing.state,
          bindingName,
          ownerDid: input.ownerDid,
          ownerHandle,
        });
    }
    const timestamp = new Date().toISOString();
    await run(
      control,
      `INSERT INTO users(did,handle,state,created_at,updated_at,last_seen_at) VALUES(?,?,'active',?,?,?)
       ON CONFLICT(did) DO UPDATE SET handle=excluded.handle,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`,
      [input.ownerDid, ownerHandle, timestamp, timestamp, timestamp],
    );
    const workspace =
      existing ??
      (await first<Workspace>(
        control,
        `INSERT INTO workspaces(id,owner_did,name,state,plan,created_at,updated_at,last_seen_at,next_dispatch_at)
         VALUES(?,?,?,'waiting_for_capacity','free',?,?,?,?) RETURNING *`,
        [
          randomId(),
          input.ownerDid,
          `${ownerHandle}'s workspace`,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        ],
      ));
    if (!workspace) throw new Error('Workspace provisioning failed');
    await run(
      control,
      `INSERT INTO memberships(workspace_id,did,role,created_at) VALUES(?,?,'owner',?) ON CONFLICT(workspace_id,did) DO NOTHING`,
      [workspace.id, input.ownerDid, timestamp],
    );
    const provisioned = await provisionWorkspace(env, workspace, {
      operatorActivation: true,
      bindingName,
    });
    if (provisioned.state !== 'active')
      throw new HttpErrorLike(
        409,
        'capacity_unavailable',
        'The selected slot cannot be assigned while preserving capacity and budget limits',
      );
    await audit(control, provisioned.id, principal.did, 'slot_assignment', {
      bindingName,
      ownerDid: input.ownerDid,
      ownerHandle,
    });
    return json({
      workspaceId: provisioned.id,
      state: provisioned.state,
      bindingName,
      ownerDid: input.ownerDid,
      ownerHandle,
    });
  }
  const slotAdmission = path.match(/^\/api\/operator\/slots\/([A-Z][A-Z0-9_]{0,63})\/admission$/);
  if (slotAdmission && request.method === 'POST') {
    const bindingName = slotAdmission[1]!;
    const input = z.object({ enabled: z.boolean() }).parse(await readJson(request));
    if (
      env.ENVIRONMENT === 'staging' &&
      bindingName === stagingImportedBindingName &&
      input.enabled
    )
      throw new HttpErrorLike(
        409,
        'explicit_assignment_required',
        'Imported data can only be assigned explicitly',
      );
    const binding = env[bindingName] as D1Database | undefined;
    if (!binding || typeof binding.prepare !== 'function')
      throw new HttpErrorLike(409, 'slot_unavailable', 'Slot is not bound to this deployment');
    const updated = await first(
      control,
      `INSERT INTO tenant_slot_controls(binding_name,admission_enabled)
      SELECT binding_name, ? FROM tenant_slots WHERE binding_name=? AND status='available' AND workspace_id IS NULL
      AND (? = 1 OR (SELECT count(*) FROM tenant_slots s
        WHERE s.status='available' AND s.workspace_id IS NULL
        AND COALESCE((SELECT admission_enabled FROM tenant_slot_controls c WHERE c.binding_name=s.binding_name),1)=1) > ?)
      ON CONFLICT(binding_name) DO UPDATE SET admission_enabled=excluded.admission_enabled RETURNING binding_name`,
      [input.enabled ? 1 : 0, bindingName, input.enabled ? 1 : 0, minimumAvailableSlots(env)],
    );
    if (!updated)
      throw new HttpErrorLike(
        409,
        'slot_in_use',
        'Only unused database slots can be held or reopened',
      );
    await audit(control, null, principal.did, 'slot_admission', { bindingName, ...input });
    return json(await slotInventory(env));
  }
  if (path === '/api/operator/workspaces' && request.method === 'GET') {
    const rows = await all<
      Workspace & {
        owner_handle: string;
        rows_read: number;
        rows_written: number;
        storage_bytes: number;
      }
    >(
      control,
      `SELECT w.*, u.handle AS owner_handle, COALESCE(SUM(d.rows_read),0) AS rows_read, COALESCE(SUM(d.rows_written),0) AS rows_written, COALESCE(MAX(d.storage_bytes),0) AS storage_bytes
       FROM workspaces w JOIN users u ON u.did = w.owner_did LEFT JOIN workspace_usage_daily d ON d.workspace_id = w.id AND d.day >= ? GROUP BY w.id ORDER BY w.created_at DESC LIMIT 100`,
      [new Date().toISOString().slice(0, 7) + '-01'],
    );
    return json({
      workspaces: await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          name: row.name,
          state: row.state,
          ownerDid: row.owner_did,
          ownerHandle: row.owner_handle,
          monitorCount: (await workspaceUsage(env, row))?.monitors ?? 0,
          rowsRead: row.rows_read,
          rowsWritten: row.rows_written,
          storageBytes: row.storage_bytes,
          lastSeenAt: row.last_seen_at,
        })),
      ),
      budget: await budgetSummary(control),
    });
  }
  const state = path.match(/^\/api\/operator\/workspaces\/([^/]+)\/state$/);
  if (state && request.method === 'POST') {
    const id = uuid.parse(state[1]);
    const input = z
      .object({ state: z.enum(['active', 'suspended']), reason: z.string().trim().min(1).max(500) })
      .parse(await readJson(request));
    const workspace = await first<Workspace>(control, 'SELECT * FROM workspaces WHERE id = ?', [
      id,
    ]);
    if (workspace?.state === 'waiting_for_capacity' && input.state === 'active') {
      const provisioned = await provisionWorkspace(env, workspace, { operatorActivation: true });
      if (provisioned.state !== 'active')
        throw new HttpErrorLike(
          409,
          'capacity_unavailable',
          'Activation needs an available database slot, space under the workspace limit, and a forecast below the budget ceiling',
        );
      await audit(control, id, principal.did, 'workspace_state', input);
      return json({ id, state: provisioned.state });
    }
    const updated = await first(
      control,
      "UPDATE workspaces SET state = ?, updated_at = ? WHERE id = ? AND state IN ('active','suspended') RETURNING id",
      [input.state, new Date().toISOString(), id],
    );
    if (!updated)
      throw new HttpErrorLike(
        409,
        'invalid_state',
        'Only provisioned workspaces can be resumed or suspended',
      );
    await audit(control, id, principal.did, 'workspace_state', input);
    return json({ id, state: input.state });
  }
  if (path === '/api/operator/controls' && request.method === 'PATCH') {
    const input = z
      .object({ admissionOpen: z.boolean(), externalMonthlyCostUsd: z.number().min(0).max(10000) })
      .parse(await readJson(request));
    await run(
      control,
      'UPDATE service_controls SET admission_open = ?, external_monthly_cost_usd = ? WHERE id = 1',
      [input.admissionOpen ? 1 : 0, input.externalMonthlyCostUsd],
    );
    await audit(control, null, principal.did, 'service_controls', input);
    return json({ budget: await budgetSummary(control) });
  }
  throw new HttpErrorLike(404, 'not_found', 'Operator endpoint was not found');
}

async function audit(
  control: D1Database,
  workspaceId: string | null,
  did: string,
  event: string,
  details: unknown,
) {
  await run(
    control,
    'INSERT INTO workspace_events(id,workspace_id,event,actor_did,created_at,details) VALUES(?,?,?,?,?,?)',
    [randomId(), workspaceId, event, did, new Date().toISOString(), JSON.stringify(details)],
  );
}

async function workspaceRequest(
  request: Request,
  env: CloudflareEnv,
  principal: AtprotoPrincipal,
  workspace: Workspace,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const control = env.CONTROL_DB as D1Database;
  if (path === '/api/workspace/usage' && request.method === 'GET')
    return json({
      usage: await workspaceUsage(env, workspace),
      limits: (await isStagingImportedWorkspace(env, workspace.id)) ? null : hostedLimits,
      budget: await budgetSummary(control),
    });
  if (path === '/api/workspace/members' && request.method === 'GET')
    return json({
      members: await all(
        control,
        `SELECT m.did, u.handle, m.role FROM memberships m JOIN users u ON u.did = m.did WHERE workspace_id = ?`,
        [workspace.id],
      ),
      invitations:
        workspace.role === 'owner'
          ? await all(
              control,
              'SELECT id, invitee_did AS inviteeDid, role FROM workspace_invitations WHERE workspace_id = ?',
              [workspace.id],
            )
          : [],
    });
  const accept = path.match(/^\/api\/workspace\/invitations\/([^/]+)\/accept$/);
  if (accept && request.method === 'POST') {
    const invitation = await first<{ workspace_id: string; role: Role }>(
      control,
      "SELECT i.workspace_id, i.role FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = ? AND i.invitee_did = ? AND i.created_at >= ? AND w.state = 'active'",
      [uuid.parse(accept[1]), principal.did, new Date(Date.now() - 7 * 86_400_000).toISOString()],
    );
    if (!invitation) throw new HttpErrorLike(404, 'not_found', 'Invitation was not found');
    await batch(control, [
      {
        sql: `INSERT INTO memberships(workspace_id,did,role,created_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM memberships WHERE workspace_id = ?) < 3 ON CONFLICT(workspace_id,did) DO NOTHING`,
        values: [
          invitation.workspace_id,
          principal.did,
          invitation.role,
          new Date().toISOString(),
          invitation.workspace_id,
        ],
      },
    ]);
    const member = await first(
      control,
      'SELECT did FROM memberships WHERE workspace_id = ? AND did = ?',
      [invitation.workspace_id, principal.did],
    );
    if (!member)
      throw new HttpErrorLike(409, 'member_limit', 'Free workspaces allow three members');
    await run(control, 'DELETE FROM workspace_invitations WHERE id = ?', [accept[1]]);
    await audit(control, invitation.workspace_id, principal.did, 'invitation_accepted', {});
    return json({ workspaceId: invitation.workspace_id });
  }
  if (path === '/api/workspace/invitations' && request.method === 'POST') {
    ownerOnly(workspace);
    const input = z
      .object({ did: didSchema, role: z.enum(['maintainer', 'viewer']) })
      .parse(await readJson(request));
    if (input.did === principal.did)
      throw new HttpErrorLike(400, 'invalid_invitation', 'Owner is already a member');
    const id = randomId();
    await run(
      control,
      'DELETE FROM workspace_invitations WHERE workspace_id = ? AND created_at < ?',
      [workspace.id, new Date(Date.now() - 7 * 86_400_000).toISOString()],
    );
    const created = await first<{ id: string }>(
      control,
      `INSERT INTO workspace_invitations(id,workspace_id,invitee_did,role,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM memberships WHERE workspace_id = ?) + (SELECT count(*) FROM workspace_invitations WHERE workspace_id = ?) < 3
      ON CONFLICT(workspace_id,invitee_did) DO UPDATE SET role = excluded.role RETURNING id`,
      [
        id,
        workspace.id,
        input.did,
        input.role,
        new Date().toISOString(),
        workspace.id,
        workspace.id,
      ],
    );
    if (!created)
      throw new HttpErrorLike(
        409,
        'member_limit',
        'Free workspaces allow three members including pending invitations',
      );
    await audit(control, workspace.id, principal.did, 'invitation_created', input);
    return json(
      { invitation: { id: created.id, inviteeDid: input.did, role: input.role } },
      { status: 201 },
    );
  }
  const member = path.match(/^\/api\/workspace\/members\/(.+)$/);
  if (member && request.method === 'DELETE') {
    ownerOnly(workspace);
    const did = didSchema.parse(decodeURIComponent(member[1]!));
    if (did === workspace.owner_did)
      throw new HttpErrorLike(409, 'owner_required', 'The owner cannot be removed');
    await run(control, 'DELETE FROM memberships WHERE workspace_id = ? AND did = ?', [
      workspace.id,
      did,
    ]);
    await run(
      control,
      'DELETE FROM workspace_invitations WHERE workspace_id = ? AND invitee_did = ?',
      [workspace.id, did],
    );
    await audit(control, workspace.id, principal.did, 'member_removed', { did });
    return json({ removed: true });
  }
  if (path === '/api/workspace' && request.method === 'DELETE') {
    ownerOnly(workspace);
    if (await isStagingImportedWorkspace(env, workspace.id))
      throw new HttpErrorLike(
        409,
        'imported_data_protected',
        'Imported staging history cannot be deleted through workspace settings',
      );
    await run(
      control,
      "UPDATE workspaces SET state = 'deleting', updated_at = ? WHERE id = ? AND state <> 'deleted'",
      [new Date().toISOString(), workspace.id],
    );
    const complete = await purgeWorkspaceData({ ...env, CONTROL_DB: control }, workspace.id);
    return json({ state: complete ? 'deleted' : 'deleting' }, { status: complete ? 200 : 202 });
  }
  if (workspace.state !== 'active')
    throw new HttpErrorLike(403, 'workspace_unavailable', 'Workspace is not active');
  const db = await activeDatabase(env, workspace.id);
  if (path === '/api/workspace/export' && request.method === 'GET') {
    ownerOnly(workspace);
    const imported = await isStagingImportedWorkspace(env, workspace.id);
    // Credential material, OAuth tokens and private delivery payloads never leave through exports.
    return json({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: { id: workspace.id, name: workspace.name },
      monitors: await all(db, `SELECT * FROM monitors LIMIT ${imported ? 1000 : 3}`),
      regions: await all(db, 'SELECT * FROM monitor_regions'),
      statusPages: await all(db, `SELECT * FROM status_pages LIMIT ${imported ? 100 : 1}`),
      groups: await all(db, 'SELECT * FROM status_page_groups'),
      pageMonitors: await all(db, 'SELECT * FROM status_page_monitors'),
      uptime: await all(db, 'SELECT * FROM monitor_daily_uptime ORDER BY day DESC LIMIT 90'),
      destinations: await all(
        db,
        `SELECT id,name,provider,enabled FROM notification_services LIMIT ${imported ? 100 : 3}`,
      ),
    });
  }
  if (path === '/api/workspace/targets' && request.method === 'GET')
    return json({
      targets: await all(
        db,
        'SELECT id, origin, expires_at AS expiresAt, verified_at AS verifiedAt FROM verified_targets ORDER BY created_at DESC LIMIT 20',
      ),
    });
  if (mutation(request) && workspace.role === 'viewer')
    throw new HttpErrorLike(403, 'forbidden', 'Viewer access is read only');
  if (path === '/api/workspace/targets' && request.method === 'POST') {
    const input = z.object({ origin: z.string().url() }).parse(await readJson(request));
    const url = monitorUrl(input.origin);
    const existing = await first<{ id: string; token: string; verified_at: string | null }>(
      db,
      'SELECT * FROM verified_targets WHERE origin = ?',
      [url.origin],
    );
    const token = existing?.token ?? randomToken();
    const id = existing?.id ?? randomId();
    if (!existing) {
      const inserted = await first(
        db,
        'INSERT INTO verified_targets(id,origin,token,expires_at,created_at) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM verified_targets) < 20 RETURNING id',
        [
          id,
          url.origin,
          token,
          new Date(Date.now() + 86_400_000).toISOString(),
          new Date().toISOString(),
        ],
      );
      if (!inserted) throw new HttpErrorLike(409, 'target_limit', 'Maximum twenty target domains');
    } else if (!existing.verified_at)
      await run(db, 'UPDATE verified_targets SET expires_at = ? WHERE id = ?', [
        new Date(Date.now() + 86_400_000).toISOString(),
        id,
      ]);
    return json({
      id,
      origin: url.origin,
      token,
      verificationUrl: `${url.origin}/.well-known/uptime-verification.txt`,
    });
  }
  const verify = path.match(/^\/api\/workspace\/targets\/([^/]+)\/verify$/);
  if (verify && request.method === 'POST') {
    await consumeBudget(control, `verify:${workspace.id}`, 5, 600);
    const target = await first<{ origin: string; token: string }>(
      db,
      'SELECT origin, token FROM verified_targets WHERE id = ? AND expires_at > ?',
      [uuid.parse(verify[1]), new Date().toISOString()],
    );
    if (!target)
      throw new HttpErrorLike(
        404,
        'challenge_expired',
        'Create a new target verification challenge',
      );
    monitorUrl(target.origin);
    const result = await fetch(`${target.origin}/.well-known/uptime-verification.txt`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok || !result.body)
      throw new HttpErrorLike(400, 'verification_failed', 'Verification file could not be fetched');
    const reader = result.body.getReader();
    let text = '';
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 2048)
          throw new HttpErrorLike(400, 'verification_failed', 'Verification file is too large');
        text += new TextDecoder().decode(part.value);
      }
    } finally {
      await reader.cancel();
    }
    if (text.trim() !== target.token)
      throw new HttpErrorLike(
        400,
        'verification_failed',
        'Verification file contents do not match',
      );
    await run(db, 'UPDATE verified_targets SET verified_at = ? WHERE id = ?', [
      new Date().toISOString(),
      verify[1],
    ]);
    return json({ verified: true });
  }
  throw new HttpErrorLike(404, 'not_found', 'Workspace endpoint was not found');
}

function ownerOnly(workspace: Workspace) {
  if (workspace.role !== 'owner')
    throw new HttpErrorLike(403, 'forbidden', 'Workspace owner access required');
}
function monitorUrl(value: string) {
  assertPublicHttpUrl(value);
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443'))
    throw new HttpErrorLike(
      400,
      'target_policy',
      'The free release supports public HTTPS targets on port 443',
    );
  return url;
}

async function enforceHostedRequest(request: Request, db: D1Database) {
  const url = new URL(request.url);
  if (
    /\/(latency|observations)$/.test(url.pathname) &&
    ['7d', '30d'].includes(url.searchParams.get('range') ?? '')
  )
    throw new HttpErrorLike(400, 'retention_limit', 'Detailed history is available for 24 hours');
  if (url.pathname.includes('/dns-diagnostics'))
    throw new HttpErrorLike(403, 'free_limit', 'DNS diagnostics are unavailable in this release');
  if (!mutation(request)) return;
  const body = (await readJson(request.clone() as unknown as Request)) as
    Record<string, unknown> | undefined;
  if (body && url.pathname.startsWith('/api/monitors') && request.method !== 'DELETE') {
    if (
      (body.intervalSeconds !== undefined && body.intervalSeconds !== 300) ||
      (body.timeoutMs !== undefined && Number(body.timeoutMs) > 10000) ||
      body.dnsDiagnosticsEnabled === true ||
      (Array.isArray(body.regionIds) && body.regionIds.length > 3) ||
      (body.outageThreshold !== undefined && body.outageThreshold !== 2) ||
      (body.recoveryThreshold !== undefined && body.recoveryThreshold !== 1) ||
      body.repeatNotificationMinutes != null
    )
      throw new HttpErrorLike(
        400,
        'free_limit',
        'Free monitors use five-minute checks, up to three regions, ten-second timeouts, two failed rounds and one recovery round',
      );
    if (typeof body.url === 'string') {
      const target = monitorUrl(body.url);
      if (
        !(await first(
          db,
          'SELECT id FROM verified_targets WHERE origin = ? AND verified_at IS NOT NULL',
          [target.origin],
        ))
      )
        throw new HttpErrorLike(
          403,
          'target_unverified',
          'Verify ownership of this target domain before creating its monitor',
        );
    }
  }
  if (
    body &&
    url.pathname.startsWith('/api/notification-services') &&
    body.provider !== undefined &&
    !['telegram', 'discord'].includes(String(body.provider))
  )
    throw new HttpErrorLike(
      400,
      'provider_unavailable',
      'This release supports Telegram and Discord destinations',
    );
}

async function redactPublicUrls(response: Response) {
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (['url', 'monitorUrl', 'finalUrl'].includes(key) && typeof child === 'string') {
          try {
            return [key, new URL(child).origin];
          } catch {
            return [key, ''];
          }
        }
        return [key, redact(child)];
      }),
    );
  };
  return json(redact(await response.json()), {
    status: response.status,
    headers: response.headers,
  });
}

async function publicReport(
  request: Request,
  env: CloudflareEnv,
  workspaceId: string,
  db: D1Database,
) {
  if (!env.REPORTS) throw new HttpErrorLike(503, 'reports_unavailable', 'Reports are unavailable');
  const url = new URL(request.url);
  const imported = await isStagingImportedWorkspace(env, workspaceId);
  if (imported && /^\/reports\/public\/monitors\//.test(url.pathname))
    return importedRequest(request, env, workspaceId, true);
  const bucket = imported ? env.REPORTS : tenantReportsBucket(env.REPORTS, workspaceId);
  const cohortKey = async (suffix: string) => {
    const pointer = await bucket.get('public/cohort.json');
    if (!pointer) throw new HttpErrorLike(503, 'report_pending', 'First report is being prepared');
    const data = z.object({ generation: z.string().regex(/^\d+$/) }).parse(await pointer.json());
    return `public/cohorts/${data.generation}/${suffix}`;
  };
  if (url.pathname === '/reports/public/status-pages.json') {
    const object = await bucket.get(await cohortKey('status-pages.json'));
    if (!object) throw new HttpErrorLike(503, 'report_pending', 'First report is being prepared');
    const snapshot = z
      .looseObject({
        statusPages: z.array(z.looseObject({ id: z.string(), publicSlug: z.string().nullable() })),
      })
      .parse(await object.json());
    const current = await all<{ id: string; public_slug: string | null }>(
      db,
      'SELECT id, public_slug FROM status_pages LIMIT 1',
    );
    snapshot.statusPages = snapshot.statusPages.filter((page) =>
      current.some((item) => item.id === page.id && item.public_slug === page.publicSlug),
    );
    return json(snapshot);
  }
  const match = url.pathname.match(
    /^\/reports\/public\/(monitors|status-pages)\/([A-Za-z0-9.-]+)\.json$/,
  );
  if (!match) throw new HttpErrorLike(404, 'not_found', 'Report was not found');
  const id = match[2]!;
  const entity =
    match[1] === 'monitors' ? await getPublicMonitor(db, id) : await getPublicStatusPage(db, id);
  if (!entity) throw new HttpErrorLike(404, 'not_found', 'Report was not found');
  if (match[1] === 'monitors') {
    const monitor = await getPublicMonitor(db, id);
    if (!monitor) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    const now = new Date();
    const [summary, uptime, latency, shortLatency] = await Promise.all([
      monitorSummary(db, monitor, log),
      monitorUptimePayload(db, monitor.id, now),
      latencyPayload(db, monitor.id, '24h', now),
      latencyPayload(db, monitor.id, '1h', now),
    ]);
    const latestObservationAt = Object.values(summary.latestByRegion).reduce<string | null>(
      (latest, item) => (item && (!latest || item.startedAt > latest) ? item.startedAt : latest),
      null,
    );
    const generatedAt = latestObservationAt ?? summary.monitor.updatedAt;
    const stale = !latestObservationAt || now.getTime() - Date.parse(latestObservationAt) > 420_000;
    const publicSummary = toPublicMonitorSummary(
      stale ? { ...summary, status: 'unknown' } : summary,
    );
    return json({
      schemaVersion: '1',
      generatedAt,
      staleAfterSeconds: 420,
      latestObservationAt,
      summary: publicSummary,
      uptime,
      latency,
      latencyByRange: { '24h': latency, '1h': shortLatency },
    });
  }
  const page = await getPublicStatusPage(db, id);
  if (!page) throw new HttpErrorLike(404, 'not_found', 'Report was not found');
  const key = await cohortKey(
    `status-pages/${encodeURIComponent(page.publicSlug ?? page.id)}.json`,
  );
  const object = await bucket.get(key);
  if (!object) throw new HttpErrorLike(503, 'report_pending', 'First report is being prepared');
  const snapshot = z
    .looseObject({
      statusPage: z.looseObject({
        id: z.string(),
        publicSlug: z.string().nullable(),
        groups: z.array(z.looseObject({ monitors: z.array(z.looseObject({ id: z.string() })) })),
      }),
    })
    .parse(await object.json());
  const publishedIds = snapshot.statusPage.groups.flatMap((group) =>
    group.monitors.map((monitor) => monitor.id),
  );
  const currentIds = new Set(
    page.groups.flatMap((group) => group.monitors.map((monitor) => monitor.id)),
  );
  if (
    snapshot.statusPage.id !== page.id ||
    snapshot.statusPage.publicSlug !== page.publicSlug ||
    publishedIds.some((id) => !currentIds.has(id))
  )
    throw new HttpErrorLike(503, 'report_pending', 'Updated report is being prepared');
  return json(snapshot);
}
