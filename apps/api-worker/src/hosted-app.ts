import {
  randomId,
  randomToken,
  tenantReportsBucket,
  purgeWorkspaceData,
  type CloudflareEnv,
  toBoolean,
  isRegionId,
  productionImportedBindingName,
  stagingImportedBindingName,
  syncWorkspaceProductLimits,
  savedWorkspaceProductLimits,
  configuredMonitorBatch,
  evaluateCapacity,
  schedulingState,
  setSchedulingPause,
  budgetEnforcementDisabled,
  type ProductLimits,
  ProductTierError,
  readProductCatalog,
  publicProductCatalog,
  saveProductCatalog,
  resolveEffectiveEntitlements,
  syncTierEntitlements,
  type TierEntitlements,
  validateProductCatalog,
} from '@uptime/cloudflare';
import {
  pgAll as all,
  pgFirst as first,
  pgRun as run,
  withPostgresRuntime,
  resolveRuntimeWorkspace,
  scopePostgresDatabase,
  type Database,
  type RuntimePostgresCatalog,
  type RuntimePostgresSource,
} from '@uptime/cloudflare/postgres';
import type { RegionId } from '@uptime/regions';
import type { StatusPageReportSnapshot } from '@uptime/contracts';
import { z } from 'zod';
import { createApiRouter, type LogSink } from './app.js';
import { monitorRequestCache } from './monitor-cache.js';
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
import { interestList, interestReturnPath, interestSignup, recordInterest } from './interest.js';
import { operatorHealth } from './operator-health.js';
import { getCloudflareUsageReport } from './cloudflare-usage.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  WorkspaceInvitationError,
} from './workspace-invitations.js';
import { billingReadiness, billingWebhook, workspaceBillingRequest } from './workspace-billing.js';
import { handleCustomDomainManagement, handleCustomDomainPublic } from './custom-domain-http.js';

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
const domainSnapshotSchema = z.looseObject({
  schemaVersion: z.string(),
  generatedAt: z.iso.datetime(),
  latestObservationAt: z.iso.datetime().nullable(),
  staleAfterSeconds: z.number().positive(),
  statusPage: z.looseObject({
    id: z.string(),
    title: z.string(),
    publicSlug: z.string().nullable(),
    groups: z.array(
      z.looseObject({
        id: z.string(),
        title: z.string(),
        width: z.enum(['full', 'half']),
        showBadges: z.boolean(),
        monitors: z.array(
          z.looseObject({
            id: z.string(),
            name: z.string().nullable(),
            status: z.enum(['up', 'down', 'unknown']),
            uptimePercentage: z.number().nullable(),
            configuredRegionCount: z.number().int().nonnegative(),
            affectedRegionIds: z.array(z.string()),
            recoveryStatus: z.enum(['up', 'down', 'recovering']).nullable(),
            days: z.array(z.unknown()),
          }),
        ),
      }),
    ),
  }),
});
const mutation = (request: Request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
export const defaultOperatorDid = 'did:plc:lmkzmvv6sdxntwtyxpg7fqqq';

export type HostedRuntimeEnv = CloudflareEnv & {
  controlDb: Database;
  catalog: RuntimePostgresCatalog;
};

async function workspaceSource(env: HostedRuntimeEnv, workspaceId: string) {
  return (await resolveRuntimeWorkspace(env.controlDb, env.catalog, workspaceId)).source;
}

async function isImportedWorkspace(env: HostedRuntimeEnv, workspaceId: string) {
  const row = await first<{ source_database_id: string; schema_name: string }>(
    env.controlDb,
    `SELECT source_database_id,schema_name FROM ${env.controlDb.table('postgres_tenant_registry')} WHERE workspace_id=$1 AND status='assigned'`,
    [workspaceId],
  );
  if (!row) return false;
  const source = env.catalog.sources.find(
    (source) =>
      source.sourceDatabaseId === row.source_database_id && source.schema === row.schema_name,
  );
  if (!source) throw new Error('Assigned source is outside the runtime catalog');
  return source.profile !== 'full-hosted';
}

async function resolveWorkspaceDatabase(env: HostedRuntimeEnv, workspaceId: string) {
  return (await resolveRuntimeWorkspace(env.controlDb, env.catalog, workspaceId)).db;
}

const resolveImportedDatabase = resolveWorkspaceDatabase;

function importedKind(source: RuntimePostgresSource) {
  return source.profile === 'legacy-production' ? 'legacy_import' : 'staging_import';
}

/** Authorize in the control database before selecting any customer data binding. */
export async function hostedFetch(
  request: Request,
  env: CloudflareEnv,
  context: ExecutionContext,
): Promise<Response> {
  try {
    return await withPostgresRuntime(env, async (controlDb, catalog) => {
      const pending: Promise<unknown>[] = [];
      const scopedContext = {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
        passThroughOnException() {
          context.passThroughOnException();
        },
      } as ExecutionContext;
      try {
        return await hostedRuntimeFetch(request, { ...env, controlDb, catalog }, scopedContext);
      } finally {
        // Drain database work before the runtime closes the event's client.
        while (pending.length) await Promise.allSettled(pending.splice(0));
      }
    });
  } catch {
    return errorResponse(500, 'internal_error', 'Worker configuration is invalid');
  }
}

export async function hostedRuntimeFetch(
  request: Request,
  env: HostedRuntimeEnv,
  context: ExecutionContext,
): Promise<Response> {
  const originalControl = env.controlDb;
  const activeProductPolicy: { limits: ProductLimits | null } = { limits: null };
  let response: Response;
  let origins: readonly string[] = [];
  try {
    const config = parseApiEnv(env);
    origins = config.allowedOrigins;
    // Stripe authenticates this public route by signature over the bounded raw body.
    if (new URL(request.url).pathname === '/api/billing/webhook' && request.method === 'POST') {
      return await billingWebhook(
        { control: originalControl, env, regions: config.enabledRegionIds },
        request,
      );
    }
    if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
    else {
      assertRequestOrigin(request, origins);
      if (mutation(request)) {
        await assertBodyLimit(request);
        if (request.headers.get('sec-fetch-site') === 'cross-site')
          throw new HttpErrorLike(403, 'origin_forbidden', 'Cross-site requests are not allowed');
      }
      const control = env.controlDb;
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
      else if (path === '/api/plans' && request.method === 'GET') {
        await consumeBudget(control, `plans:${clientAddress(request)}`, 60, 60);
        const catalog = await readProductCatalog(control, config.enabledRegionIds);
        const pricing = publicProductCatalog(catalog);
        const billing = await billingReadiness(
          { control, env, regions: config.enabledRegionIds },
          catalog,
        );
        response = json({
          ...pricing,
          billing,
          capabilities: { ...pricing.capabilities, checkout: billing.ready },
        });
      } else if (path.startsWith('/api/public/custom-status/')) {
        await consumeBudget(control, `custom-status:${clientAddress(request)}`, 60, 60);
        await consumeBudget(control, 'public:global', 20_000, 86_400);
        response = await handleCustomDomainPublic(request, env, async (target) => {
          const reportUrl = new URL(
            `/reports/public/status-pages/${encodeURIComponent(target.publicSlug)}.json`,
            request.url,
          );
          reportUrl.searchParams.set('workspace', target.workspaceId);
          const report = await publicReport(
            new Request(reportUrl, { method: 'GET' }),
            env,
            target.workspaceId,
            await activeDatabase(env, target.workspaceId),
          );
          if (!report.ok) return null;
          const parsed = domainSnapshotSchema.safeParse(await report.json());
          if (!parsed.success) return null;
          const snapshot = parsed.data as unknown as StatusPageReportSnapshot;
          if (
            snapshot.statusPage.id !== target.statusPageId ||
            snapshot.statusPage.publicSlug !== target.publicSlug
          )
            return null;
          return snapshot;
        });
      } else if (path === '/api/auth/atproto/start' && request.method === 'POST') {
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
          `SELECT state FROM ${control.table('users')} WHERE did = $1`,
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
          `SELECT state FROM ${control.table('users')} WHERE did=$1`,
          [principal.did],
        );
        if (user?.state !== 'active')
          throw new HttpErrorLike(403, 'forbidden', 'Imported workspace access denied');
        const workspaceId = uuid.parse(request.headers.get('x-uptime-workspace'));
        const workspace = await accessibleWorkspace(control, principal.did, workspaceId);
        if (workspace.state !== 'active' || !(await isImportedWorkspace(env, workspaceId)))
          throw new HttpErrorLike(403, 'forbidden', 'Imported workspace access denied');
        await resolveImportedDatabase(env, workspaceId);
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
        const imported = await isImportedWorkspace(env, workspaceId);
        if (!imported) await enforceHostedRequest(request, db, undefined, config.enabledRegionIds);
        response = path.startsWith('/reports/')
          ? await publicReport(request, env, workspaceId, db)
          : imported
            ? await importedRequest(request, env, workspaceId)
            : await dispatch(request, url, db, config, undefined, workspaceId);
        response = await redactPublicUrls(response);
      } else {
        const principal = await auth.principal(request);
        if (!principal) throw new HttpErrorLike(401, 'unauthorized', 'Sign in with AT Protocol');
        await consumeBudget(control, `user:${principal.did}`, 120, 60);
        const user = await first<{ state: string }>(
          control,
          `SELECT state FROM ${control.table('users')} WHERE did = $1`,
          [principal.did],
        );
        if (user && user.state !== 'active')
          throw new HttpErrorLike(403, 'account_suspended', 'Account is suspended');
        const isOperator = operatorDids(env).includes(principal.did);
        if (toBoolean(env.INTEREST_CHECK_ONLY) && !isOperator) {
          const membership = await first(
            control,
            `SELECT workspace_id FROM ${control.table('memberships')} WHERE did=$1 LIMIT 1`,
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
            `UPDATE ${control.table('workspaces')} SET last_seen_at = $1 WHERE id = $2 AND (last_seen_at IS NULL OR last_seen_at < $3)`,
            [
              new Date().toISOString(),
              selected.id,
              new Date(Date.now() - 15 * 60_000).toISOString(),
            ],
          );
          if (path === '/api/auth/session' && request.method === 'GET') {
            const imported = await isImportedWorkspace(env, selected.id);
            response = json({
              user: principal,
              workspace: {
                id: selected.id,
                name: selected.name,
                state: selected.state,
                plan: 'free',
                ...(imported
                  ? { kind: importedKind(await workspaceSource(env, selected.id)) }
                  : {}),
              },
              role: selected.role,
              isOperator,
              limits: imported
                ? null
                : productLimitsResponse(
                    await getWorkspaceProductLimits(env, selected.id, config.enabledRegionIds),
                  ),
              usage: await workspaceUsage(env, selected),
              budget: await budgetSummary(control, env),
              workspaces: await all(
                control,
                `SELECT w.id, w.name, w.state, m.role FROM ${control.table('workspaces')} w JOIN ${control.table('memberships')} m ON m.workspace_id = w.id WHERE m.did = $1 AND w.state <> 'deleted'`,
                [principal.did],
              ),
            });
          } else if (
            path === '/api/workspace/custom-domains' ||
            path.startsWith('/api/workspace/custom-domains/')
          ) {
            response = await handleCustomDomainManagement(
              request,
              env,
              {
                workspaceId: selected.id,
                actorDid: principal.did,
                role: selected.role === 'maintainer' ? 'member' : (selected.role ?? 'viewer'),
              },
              { withWriteLease: (id, execute) => withWorkspaceWriteLease(control, id, execute) },
            );
          } else if (
            path === '/api/workspace/billing' ||
            path.startsWith('/api/workspace/billing/')
          ) {
            response = await workspaceBillingRequest(
              { control, env, regions: config.enabledRegionIds },
              request,
              selected,
              principal.did,
            );
          } else if (path === '/api/workspace/entitlements' && request.method === 'GET') {
            if (await isImportedWorkspace(env, selected.id)) {
              response = json({
                legacyExempt: true,
                entitlements: null,
                overrides: null,
                usage: await workspaceUsage(env, selected),
                downgrade: null,
              });
            } else {
              const effective = await resolveEffectiveEntitlements(
                control,
                selected.id,
                config.enabledRegionIds,
              );
              const db = await activeDatabase(env, selected.id);
              // Reads calculate from the current authoritative policy without writing tenant state.
              const enabled = await all<{ id: string; regions: number; disallowed: number }>(
                db,
                `SELECT m.id,(SELECT count(*)::integer FROM ${db.table('monitor_regions')} WHERE monitor_id=m.id) AS regions,
                  (SELECT count(*)::integer FROM ${db.table('monitor_regions')} WHERE monitor_id=m.id AND NOT (region_id = ANY($1::text[]))) AS disallowed FROM ${db.table('monitors')} m WHERE enabled=1 ORDER BY created_at,id`,
                [effective.entitlements.allowedRegionIds],
              );
              const pausedMonitors = enabled
                .filter(
                  (m, index) =>
                    index >= effective.entitlements.monitors ||
                    m.regions > effective.entitlements.regions ||
                    m.disallowed > 0,
                )
                .map((m) => ({ id: m.id, reason: 'product_quota_or_region_policy' }));
              const resources = await workspaceUsage(env, selected);
              const seats = await first<{ members: number; pendingInvites: number }>(
                control,
                `SELECT (SELECT count(*)::integer FROM ${control.table('memberships')} WHERE workspace_id=$1) AS members,
                  (SELECT count(*)::integer FROM ${control.table('workspace_invitations')} WHERE workspace_id=$2 AND created_at>$3) AS "pendingInvites"`,
                [selected.id, selected.id, new Date(Date.now() - 7 * 86_400_000).toISOString()],
              );
              const usage = {
                ...resources,
                enabledMonitors: enabled.length,
                notificationDestinations: resources?.notificationServices ?? 0,
                members: seats?.members ?? 0,
                pendingInvites: seats?.pendingInvites ?? 0,
                seats: (seats?.members ?? 0) + (seats?.pendingInvites ?? 0),
              };
              const overLimitResources = Object.entries({
                monitors: (resources?.monitors ?? 0) > effective.entitlements.monitors,
                statusPages: (resources?.statusPages ?? 0) > effective.entitlements.statusPages,
                notificationDestinations:
                  usage.notificationDestinations > effective.entitlements.notificationDestinations,
                seats: usage.seats > effective.entitlements.seats,
              })
                .filter(([, over]) => over)
                .map(([name]) => name);
              response = json({
                ...effective,
                usage,
                downgrade: {
                  overLimit: pausedMonitors.length > 0 || overLimitResources.length > 0,
                  overLimitResources,
                  pausedMonitorCount: pausedMonitors.length,
                  pausedMonitors,
                },
              });
            }
          } else if (path.startsWith('/api/workspace')) {
            response = await workspaceRequest(request, env, principal, selected);
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
            const imported = await isImportedWorkspace(env, selected.id);
            const execute = async () => {
              if (imported) return importedRequest(request, env, selected.id);
              const limits = await getWorkspaceProductLimits(
                env,
                selected.id,
                config.enabledRegionIds,
              );
              activeProductPolicy.limits = limits;
              if (mutation(request))
                await withWorkspacePolicy(env, selected.id, async (tx, tenant) => {
                  await syncTierEntitlements(
                    tenant,
                    await resolveEffectiveEntitlements(tx, selected.id, config.enabledRegionIds),
                  );
                });
              await enforceHostedRequest(request, db, limits, config.enabledRegionIds);
              const allowed = new Set(limits.allowedRegionIds);
              const tenantConfig = {
                ...config,
                enabledRegionIds: config.enabledRegionIds.filter((region) => allowed.has(region)),
                enabledRegions: config.enabledRegions.filter((region) => allowed.has(region.id)),
              };
              // Editing or disabling retained monitors must not require deleting old region configuration.
              if (request.method === 'PATCH' && /^\/api\/monitors\/[a-f0-9-]{36}$/.test(path)) {
                const body = (await readJson(request.clone() as unknown as Request)) as Record<
                  string,
                  unknown
                >;
                if (body && body.regionIds === undefined) {
                  const saved = await all<{ region_id: RegionId }>(
                    db,
                    `SELECT region_id FROM ${db.table('monitor_regions')} WHERE monitor_id=$1`,
                    [path.split('/').at(-1)],
                  );
                  tenantConfig.enabledRegionIds = [
                    ...new Set([
                      ...tenantConfig.enabledRegionIds,
                      ...saved.map((r) => r.region_id),
                    ]),
                  ];
                }
              }
              return dispatch(request, url, db, tenantConfig, principal, selected.id);
            };
            response = mutation(request)
              ? await withWorkspaceWriteLease(control, selected.id, execute)
              : await execute();
          }
        }
      }
    }
  } catch (error) {
    if (
      error instanceof HttpErrorLike ||
      error instanceof WorkspaceInvitationError ||
      error instanceof ProductTierError
    )
      response = errorResponse(error.status, error.code, error.message);
    else if (error instanceof UrlPolicyError)
      response = errorResponse(400, error.code, error.message);
    else if (error instanceof Error && /workspace_seat_limit/.test(error.message))
      response = errorResponse(409, 'member_limit', 'Workspace seat quota is full');
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
      response = errorResponse(
        409,
        'product_limit',
        /free_monitor_limit/.test(error.message)
          ? `This workspace can save up to ${activeProductPolicy.limits?.monitors ?? hostedLimits.monitors} monitors`
          : /free_region_limit/.test(error.message)
            ? `This workspace can use up to ${activeProductPolicy.limits?.regions ?? hostedLimits.regions} regions per monitor`
            : 'This operation exceeds the hosted product limits',
      );
    else {
      log.error?.({ event: 'hosted_request_failed' }, 'Hosted request failed');
      response = errorResponse(500, 'internal_error', 'Request could not be completed');
    }
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, origins))) headers.set(key, value);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, headers });
}

async function dispatch(
  request: Request,
  url: URL,
  db: Database,
  config: ReturnType<typeof parseApiEnv>,
  principal?: AtprotoPrincipal,
  monitorCacheScope?: string,
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
      ...(monitorCacheScope ? { monitorCacheScope } : {}),
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
  env: HostedRuntimeEnv,
  workspaceId: string,
  report = false,
) {
  const binding = env[report ? 'IMPORTED_REPORTER' : 'IMPORTED_API'] as
    { fetch(request: Request): Promise<Response> } | undefined;
  if (
    !(await isImportedWorkspace(env, workspaceId)) ||
    !binding ||
    typeof binding.fetch !== 'function'
  )
    throw new HttpErrorLike(503, 'imported_unavailable', 'Imported service is unavailable');
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
] as const;
const importedBindingNames = [stagingImportedBindingName, productionImportedBindingName] as const;
function reservedSlotNames(env: CloudflareEnv): readonly string[] {
  return [
    ...(env.ENVIRONMENT === 'staging' ? stagingReservedSlotNames : []),
    ...importedBindingNames,
  ];
}
function isReservedSlot(env: CloudflareEnv, bindingName: string | undefined) {
  return reservedSlotNames(env).includes(bindingName ?? '');
}
async function activeDatabase(env: HostedRuntimeEnv, id: string) {
  const workspace = await first<Workspace>(
    env.controlDb,
    `SELECT * FROM ${env.controlDb.table('workspaces')} WHERE id = $1 AND state = $2`,
    [id, 'active'],
  );
  if (!workspace) throw new HttpErrorLike(404, 'not_found', 'Workspace was not found');
  if (await isImportedWorkspace(env, id)) return resolveImportedDatabase(env, id);
  return resolveWorkspaceDatabase(env, id);
}
async function accessibleWorkspace(control: Database, did: string, id: string) {
  const workspace = await first<Workspace>(
    control,
    `SELECT w.*, m.role FROM ${control.table('workspaces')} w JOIN ${control.table('memberships')} m ON m.workspace_id = w.id WHERE w.id = $1 AND m.did = $2 AND w.state <> 'deleted'`,
    [id, did],
  );
  if (!workspace) throw new HttpErrorLike(403, 'forbidden', 'Workspace access denied');
  return workspace;
}

async function withWorkspacePolicy<T>(
  env: HostedRuntimeEnv,
  workspaceId: string,
  execute: (control: Database, tenant: Database) => Promise<T>,
): Promise<T> {
  return env.controlDb.transaction(async (tx) => {
    const workspace = await first(
      tx,
      `SELECT id FROM ${tx.table('workspaces')} WHERE id=$1 AND state IN ('active','suspended') FOR NO KEY UPDATE`,
      [workspaceId],
    );
    if (!workspace)
      throw new HttpErrorLike(409, 'workspace_unavailable', 'Workspace is not provisioned');
    const row = await first<{ source_database_id: string; schema_name: string }>(
      tx,
      `SELECT source_database_id,schema_name FROM ${tx.table('postgres_tenant_registry')} WHERE workspace_id=$1 AND status='assigned' FOR SHARE`,
      [workspaceId],
    );
    const source =
      row &&
      env.catalog.sources.find(
        (source) =>
          source.sourceDatabaseId === row.source_database_id && source.schema === row.schema_name,
      );
    if (!source || source.profile !== 'full-hosted')
      throw new Error('Hosted source identity is unavailable');
    const tenant = scopePostgresDatabase(tx, source);
    const marker = await first<{ workspace_id: string; database_id: string; marker_count: number }>(
      tenant,
      `SELECT workspace_id,database_id,(SELECT count(*)::integer FROM ${tenant.table('workspace_metadata')}) AS marker_count FROM ${tenant.table('workspace_metadata')} WHERE id=1 FOR NO KEY UPDATE`,
    );
    if (
      marker?.workspace_id !== workspaceId ||
      marker.database_id !== source.sourceDatabaseId ||
      marker.marker_count !== 1
    )
      throw new Error('Tenant identity mismatch');
    return execute(tx, tenant);
  });
}

/** Drain in-flight API writes before deletion, using the same fence as scheduled work. */
async function withWorkspaceWriteLease(
  control: Database,
  workspaceId: string,
  execute: () => Promise<Response>,
  allowSuspended = false,
) {
  const token = randomToken(16);
  const now = new Date();
  const statePredicate = allowSuspended ? "state IN ('active','suspended')" : "state = 'active'";
  const lease = await first(
    control,
    `UPDATE ${control.table('workspaces')} SET execution_lease_token = $1, execution_lease_until = $2
    WHERE id = $3 AND ${statePredicate} AND (execution_lease_until IS NULL OR execution_lease_until <= $4) RETURNING id`,
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
      `UPDATE ${control.table('workspaces')} SET execution_lease_token = NULL, execution_lease_until = NULL WHERE id = $1 AND execution_lease_token = $2`,
      [workspaceId, token],
    );
  }
}

/** Retry an interrupted allocation using its reserved slot. Slots are never reused automatically. */
export async function ensureWorkspace(
  env: HostedRuntimeEnv,
  principal: AtprotoPrincipal,
): Promise<Workspace> {
  const control = env.controlDb;
  const timestamp = new Date().toISOString();
  await run(
    control,
    `INSERT INTO ${control.table('users')}(did,handle,state,created_at,updated_at,last_seen_at) VALUES($1,$2,'active',$3,$4,$5) ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
    [principal.did, principal.handle, timestamp, timestamp, timestamp],
  );
  await run(
    control,
    `INSERT INTO ${control.table('workspaces')}(id,owner_did,name,state,plan,created_at,updated_at,last_seen_at,next_dispatch_at)
    VALUES($1,$2,$3,'waiting_for_capacity','free',$4,$5,$6,$7) ON CONFLICT(owner_did) DO NOTHING`,
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
    `SELECT * FROM ${control.table('workspaces')} WHERE owner_did = $1`,
    [principal.did],
  );
  if (!workspace) throw new Error('Workspace provisioning failed');
  if (workspace.state === 'deleted' || workspace.state === 'deleting') return workspace;
  await run(
    control,
    `INSERT INTO ${control.table('memberships')}(workspace_id,did,role,created_at) VALUES($1,$2,'owner',$3) ON CONFLICT(workspace_id,did) DO NOTHING`,
    [workspace.id, principal.did, timestamp],
  );
  return provisionWorkspace(env, workspace);
}

async function provisionWorkspace(
  env: HostedRuntimeEnv,
  workspace: Workspace,
  options: { operatorActivation?: boolean; bindingName?: string } = {},
): Promise<Workspace> {
  const control = env.controlDb;
  const timestamp = new Date().toISOString();
  const operatorActivation = options.operatorActivation === true;
  const explicitBinding = typeof options.bindingName === 'string';
  const reservedInExplicitCapacity = explicitBinding && isReservedSlot(env, options.bindingName);
  if (explicitBinding) {
    const physical = await first<{ source_database_id: string; schema_name: string }>(
      control,
      `SELECT r.source_database_id,r.schema_name FROM ${control.table('postgres_tenant_registry')} r JOIN ${control.table('tenant_slots')} s ON s.database_id=r.source_database_id WHERE s.binding_name=$1`,
      [options.bindingName],
    );
    const source =
      physical &&
      env.catalog.sources.find(
        (source) =>
          source.sourceDatabaseId === physical.source_database_id &&
          source.schema === physical.schema_name,
      );
    if (source && source.profile !== 'full-hosted') {
      return control.transaction(async (tx) => {
        const current = await first<Workspace>(
          tx,
          `SELECT * FROM ${tx.table('workspaces')} WHERE id=$1 AND state IN ('waiting_for_capacity','active','suspended') FOR NO KEY UPDATE`,
          [workspace.id],
        );
        if (!current)
          throw new HttpErrorLike(
            409,
            'workspace_unavailable',
            'Imported workspace is unavailable',
          );
        const registry = await first<{ status: string; workspace_id: string | null }>(
          tx,
          `SELECT status,workspace_id FROM ${tx.table('postgres_tenant_registry')} WHERE source_database_id=$1 AND schema_name=$2 FOR UPDATE`,
          [source.sourceDatabaseId, source.schema],
        );
        if (
          !registry ||
          !(
            (registry.status === 'available' && registry.workspace_id === null) ||
            (registry.status === 'assigned' && registry.workspace_id === workspace.id)
          )
        )
          throw new HttpErrorLike(409, 'slot_unavailable', 'Imported source is unavailable');
        await run(
          tx,
          `UPDATE ${tx.table('postgres_tenant_registry')} SET workspace_id=$1,status='assigned',updated_at=$2 WHERE source_database_id=$3`,
          [workspace.id, timestamp, source.sourceDatabaseId],
        );
        const tenant = scopePostgresDatabase(tx, source);
        let markers = await all<{ id: number; workspace_id: string; database_id: string }>(
          tenant,
          `SELECT id,workspace_id,database_id FROM ${tenant.table(source.identityTable!)} FOR NO KEY UPDATE`,
        );
        // Staging's explicit first assignment creates its historical three-column marker.
        // An existing marker, and every production marker, must retain its identity.
        if (
          markers.length === 0 &&
          source.profile === 'legacy-staging' &&
          env.ENVIRONMENT === 'staging'
        ) {
          await run(
            tenant,
            `INSERT INTO ${tenant.table(source.identityTable!)}(id,workspace_id,database_id)
             VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING`,
            [workspace.id, source.sourceDatabaseId],
          );
          markers = await all(
            tenant,
            `SELECT id,workspace_id,database_id FROM ${tenant.table(source.identityTable!)} FOR NO KEY UPDATE`,
          );
        }
        if (
          markers.length !== 1 ||
          markers[0]!.id !== 1 ||
          markers[0]!.workspace_id !== workspace.id ||
          markers[0]!.database_id !== source.sourceDatabaseId
        )
          throw new HttpErrorLike(
            409,
            'imported_identity_mismatch',
            'Imported source identity must be preserved',
          );
        await run(
          tx,
          `UPDATE ${tx.table('tenant_slots')} SET workspace_id=$1,status='assigned' WHERE database_id=$2`,
          [workspace.id, source.sourceDatabaseId],
        );
        if (current.state === 'waiting_for_capacity') {
          await run(
            tx,
            `UPDATE ${tx.table('workspaces')} SET state='active',updated_at=$1 WHERE id=$2`,
            [timestamp, workspace.id],
          );
          current.state = 'active';
        }
        return current;
      });
    }
  }
  if (workspace.state === 'waiting_for_capacity') {
    // Manual operator activation skips the cost-admission gate. Slot, reserve, and workspace-cap
    // checks below still apply, and monitoring dispatch enforces budget pauses on its own.
    const budget = operatorActivation ? null : await budgetSummary(control, env);
    if (
      operatorActivation ||
      (budget !== null &&
        budget.admissionOpen &&
        (budget.enforcementDisabled || (budget.forecastUsd !== null && budget.forecastUsd < 15)))
    ) {
      await control.transaction(async (tx) => {
        // Serialize global admission and the reserve before selecting a physical source.
        const settings = await first<{ max_workspaces: number }>(
          tx,
          `SELECT max_workspaces FROM ${tx.table('service_controls')} WHERE id=1 FOR UPDATE`,
        );
        const current = await first<Workspace>(
          tx,
          `SELECT * FROM ${tx.table('workspaces')} WHERE id=$1 FOR NO KEY UPDATE`,
          [workspace.id],
        );
        if (current?.state !== 'waiting_for_capacity') return;
        const already = await first<{
          source_database_id: string;
          schema_name: string;
          status: string;
        }>(
          tx,
          `SELECT source_database_id,schema_name,status FROM ${tx.table('postgres_tenant_registry')} WHERE workspace_id=$1 FOR UPDATE`,
          [workspace.id],
        );
        if (already) {
          const source = env.catalog.sources.find(
            (source) =>
              source.sourceDatabaseId === already.source_database_id &&
              source.schema === already.schema_name,
          );
          if (!source || already.status !== 'assigned')
            throw new Error('Reserved source identity is unavailable');
          const tenant = scopePostgresDatabase(tx, source);
          const markers = await all<{ id: number; workspace_id: string; database_id: string }>(
            tenant,
            `SELECT id,workspace_id,database_id FROM ${tenant.table(source.identityTable!)} FOR NO KEY UPDATE`,
          );
          if (
            markers.length !== 1 ||
            markers[0]!.id !== 1 ||
            markers[0]!.workspace_id !== workspace.id ||
            markers[0]!.database_id !== source.sourceDatabaseId
          )
            throw new Error('Tenant identity mismatch');
          if (source.profile === 'full-hosted')
            await syncTierEntitlements(
              tenant,
              await resolveEffectiveEntitlements(
                tx,
                workspace.id,
                parseApiEnv(env).enabledRegionIds,
              ),
            );
          await run(
            tx,
            `UPDATE ${tx.table('workspaces')} SET state='active',updated_at=$1 WHERE id=$2`,
            [timestamp, workspace.id],
          );
          return;
        }
        const inventory = await all<{
          source_database_id: string;
          schema_name: string;
          status: string;
          binding_name: string | null;
          admission_enabled: number;
        }>(
          tx,
          `SELECT r.*,s.binding_name,COALESCE(c.admission_enabled,1) AS admission_enabled
           FROM ${tx.table('postgres_tenant_registry')} r
           LEFT JOIN ${tx.table('tenant_slots')} s ON s.database_id=r.source_database_id
           LEFT JOIN ${tx.table('tenant_slot_controls')} c ON c.binding_name=s.binding_name
           ORDER BY r.source_database_id FOR UPDATE OF r`,
        );
        const publicRows = inventory.filter(
          (row) =>
            env.catalog.sources.some(
              (source) =>
                source.sourceDatabaseId === row.source_database_id &&
                source.schema === row.schema_name &&
                source.profile === 'full-hosted',
            ) && !isReservedSlot(env, row.binding_name ?? undefined),
        );
        const available = publicRows.filter(
          (row) => row.status === 'available' && row.admission_enabled === 1,
        );
        const candidate = explicitBinding
          ? inventory.find(
              (row) => row.binding_name === options.bindingName && row.status === 'available',
            )
          : available[0];
        if (!candidate) return;
        const source = env.catalog.sources.find(
          (source) =>
            source.sourceDatabaseId === candidate.source_database_id &&
            source.schema === candidate.schema_name,
        );
        if (!source) throw new Error('Physical source is outside the runtime catalog');
        const imported = source.profile !== 'full-hosted';
        if (imported && !explicitBinding)
          throw new Error('Legacy sources require explicit assignment');
        if (!imported) {
          if (
            !reservedInExplicitCapacity &&
            publicRows.filter((row) => row.status === 'assigned').length >=
              (settings?.max_workspaces ?? 10)
          )
            return;
          if (
            available.length - (available.includes(candidate) ? 1 : 0) <
            minimumAvailableSlots(env)
          )
            return;
        }
        await run(
          tx,
          `UPDATE ${tx.table('postgres_tenant_registry')} SET workspace_id=$1,status='assigned',updated_at=$2 WHERE source_database_id=$3`,
          [workspace.id, timestamp, source.sourceDatabaseId],
        );
        const tenant = scopePostgresDatabase(tx, source);
        const markerTable = source.identityTable!;
        const markers = await all<{ id: number; workspace_id: string; database_id: string }>(
          tenant,
          `SELECT id,workspace_id,database_id FROM ${tenant.table(markerTable)} FOR NO KEY UPDATE`,
        );
        if (
          markers.length > 1 ||
          (markers.length === 1 &&
            (markers[0]!.id !== 1 ||
              markers[0]!.workspace_id !== workspace.id ||
              markers[0]!.database_id !== source.sourceDatabaseId))
        )
          throw new Error('Tenant identity mismatch');
        if (!markers.length) {
          if (imported) throw new Error('Legacy import identity marker must already exist');
          const contents = await first<{ n: number }>(
            tenant,
            `SELECT ((SELECT count(*) FROM ${tenant.table('monitors')})+(SELECT count(*) FROM ${tenant.table('notification_services')})+(SELECT count(*) FROM ${tenant.table('status_pages')}))::integer AS n`,
          );
          if (contents?.n !== 0) throw new Error('Only empty databases may enter the tenant pool');
          await run(
            tenant,
            `INSERT INTO ${tenant.table('workspace_metadata')}(id,workspace_id,database_id,plan,routing_generation) VALUES(1,$1,$2,'free',1)`,
            [workspace.id, source.sourceDatabaseId],
          );
        }
        if (!imported)
          await syncTierEntitlements(
            tenant,
            await resolveEffectiveEntitlements(tx, workspace.id, parseApiEnv(env).enabledRegionIds),
          );
        await run(
          tx,
          `UPDATE ${tx.table('tenant_slots')} SET workspace_id=$1,status='assigned' WHERE database_id=$2`,
          [workspace.id, source.sourceDatabaseId],
        );
        await run(
          tx,
          `UPDATE ${tx.table('workspaces')} SET state='active',updated_at=$1 WHERE id=$2 AND state='waiting_for_capacity'`,
          [timestamp, workspace.id],
        );
      });
    }
    const current = await first<Workspace>(
      control,
      `SELECT * FROM ${control.table('workspaces')} WHERE id=$1`,
      [workspace.id],
    );
    if (current) Object.assign(workspace, current);
    if (current?.state === 'active') await resolveWorkspaceDatabase(env, workspace.id);
  }
  return workspace;
}

export async function consumeBudget(
  control: Database,
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
    `INSERT INTO ${control.table('request_budgets')} AS budget(key,window_started_at,count) VALUES($1,$2,1)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN budget.window_started_at = excluded.window_started_at THEN budget.count + 1 ELSE 1 END,
      window_started_at = excluded.window_started_at
    WHERE budget.window_started_at <> excluded.window_started_at OR budget.count < $3 RETURNING count`,
    [key, window, maximum],
  );
  if (!row) throw new HttpErrorLike(429, 'rate_limited', 'Request limit reached. Try again later');
}

export async function budgetSummary(
  control: Database,
  env?: Record<string, unknown>,
  now = new Date(),
) {
  const settings = await first<{
    monthly_budget_usd: number;
    admission_open: number;
    external_monthly_cost_usd: number;
  }>(control, `SELECT * FROM ${control.table('service_controls')} WHERE id = 1`);
  let observedAt: string | null = null;
  let cloudflareCostUsd: number | null = null;
  if (typeof env?.CURRENT_BUDGET_USAGE_JSON === 'string') {
    try {
      const value = z
        .object({
          month: z.string(),
          observedAt: z.iso.datetime(),
          cloudflareCostUsd: z.number().finite().nonnegative(),
        })
        .parse(JSON.parse(env.CURRENT_BUDGET_USAGE_JSON));
      const age = now.getTime() - Date.parse(value.observedAt);
      if (value.month === now.toISOString().slice(0, 7) && age >= 0 && age <= 3_600_000) {
        observedAt = value.observedAt;
        cloudflareCostUsd = value.cloudflareCostUsd;
      }
    } catch {
      /* Invalid observations remain unknown. */
    }
  }
  const forecastUsd =
    cloudflareCostUsd === null
      ? null
      : cloudflareCostUsd + Number(settings?.external_monthly_cost_usd ?? 0);
  const enforcementDisabled = budgetEnforcementDisabled(env);
  return {
    ceilingUsd: Math.min(20, Number(settings?.monthly_budget_usd ?? 20)),
    baseUsd: null,
    externalMonthlyCostUsd: Number(settings?.external_monthly_cost_usd ?? 0),
    forecastUsd,
    cloudflareCostUsd,
    observedAt,
    enforcementDisabled,
    // The admission setting still applies. Only the cost forecast condition is skipped.
    admissionOpen:
      settings?.admission_open === 1 &&
      (enforcementDisabled ||
        (forecastUsd !== null &&
          forecastUsd < Math.min(15, Number(settings?.monthly_budget_usd ?? 20)))),
    billingWindow: 'current_calendar_month',
    coverage:
      'Current observed Cloudflare cost plus manually entered external costs. PostgreSQL statements and duration are telemetry only.',
  };
}

async function workspaceUsage(env: HostedRuntimeEnv, workspace: Workspace) {
  if (!['active', 'suspended'].includes(workspace.state))
    return { monitors: 0, statusPages: 0, notificationServices: 0 };
  const db = (await isImportedWorkspace(env, workspace.id))
    ? await resolveImportedDatabase(env, workspace.id)
    : await resolveWorkspaceDatabase(env, workspace.id);
  return await first<{ monitors: number; statusPages: number; notificationServices: number }>(
    db,
    `SELECT (SELECT count(*)::integer FROM ${db.table('monitors')}) AS monitors, (SELECT count(*)::integer FROM ${db.table('status_pages')}) AS "statusPages", (SELECT count(*)::integer FROM ${db.table('notification_services')}) AS "notificationServices"`,
  );
}

async function getWorkspaceProductLimits(
  env: HostedRuntimeEnv,
  workspaceId: string,
  configuredRegionIds: readonly RegionId[] = parseApiEnv(env).enabledRegionIds,
): Promise<TierEntitlements> {
  return (await resolveEffectiveEntitlements(env.controlDb, workspaceId, configuredRegionIds))
    .entitlements;
}

function productLimitsResponse(limits: ProductLimits) {
  return {
    ...hostedLimits,
    monitors: limits.monitors,
    regions: limits.regions,
    allowedRegionIds: limits.allowedRegionIds,
    ...('statusPages' in limits
      ? {
          statusPages: (limits as TierEntitlements).statusPages,
          notificationServices: (limits as TierEntitlements).notificationDestinations,
          seats: (limits as TierEntitlements).seats,
          customDomains: (limits as TierEntitlements).customDomains,
        }
      : {}),
  };
}

async function operatorWorkspaceLimits(
  env: HostedRuntimeEnv,
  workspace: Workspace,
  configuredRegionIds: readonly RegionId[],
) {
  if (!['active', 'suspended', 'waiting_for_capacity'].includes(workspace.state)) return null;
  if (await isImportedWorkspace(env, workspace.id)) return null;
  const slot = await first(
    env.controlDb,
    `SELECT source_database_id FROM ${env.controlDb.table('postgres_tenant_registry')} WHERE workspace_id = $1 AND status = 'assigned'`,
    [workspace.id],
  );
  if (!slot && workspace.state !== 'waiting_for_capacity') return null;
  const limits = await getWorkspaceProductLimits(env, workspace.id, configuredRegionIds);
  const settings = await first<{ max_workspaces: number }>(
    env.controlDb,
    `SELECT max_workspaces FROM ${env.controlDb.table('service_controls')} WHERE id=1`,
  );
  return {
    ...productLimitsResponse(limits),
    capacity: evaluateCapacity(
      limits,
      configuredMonitorBatch(env),
      null,
      settings?.max_workspaces ?? 10,
    ),
  };
}

async function workspaceCapacity(
  env: HostedRuntimeEnv,
  workspaceId: string,
  limits: ProductLimits,
) {
  const workspace = await first<Workspace>(
    env.controlDb,
    `SELECT * FROM ${env.controlDb.table('workspaces')} WHERE id=$1`,
    [workspaceId],
  );
  if (!workspace) throw new HttpErrorLike(404, 'workspace_not_found', 'Workspace was not found');
  if (!['active', 'suspended', 'waiting_for_capacity'].includes(workspace.state))
    throw new HttpErrorLike(
      409,
      'limits_unsupported',
      'Product limits cannot be edited in this workspace state',
    );
  let actual: { monitors: number; regionalTasks: number } | null;
  if (workspace.state === 'waiting_for_capacity') {
    const reserved = await first(
      env.controlDb,
      `SELECT source_database_id FROM ${env.controlDb.table('postgres_tenant_registry')} WHERE workspace_id=$1`,
      [workspaceId],
    );
    if (reserved)
      throw new HttpErrorLike(
        409,
        'workspace_busy',
        'Workspace provisioning must finish before editing limits',
      );
    actual = { monitors: 0, regionalTasks: 0 };
  } else {
    const db = await resolveWorkspaceDatabase(env, workspaceId);
    actual = await first<{ monitors: number; regionalTasks: number }>(
      db,
      `SELECT count(*)::integer AS monitors, COALESCE(sum((SELECT count(*) FROM ${db.table('monitor_regions')} mr
        WHERE mr.monitor_id=m.id)),0)::integer AS "regionalTasks" FROM ${db.table('monitors')} m WHERE enabled=1`,
    );
  }
  const settings = await first<{ max_workspaces: number }>(
    env.controlDb,
    `SELECT max_workspaces FROM ${env.controlDb.table('service_controls')} WHERE id=1`,
  );
  return evaluateCapacity(
    limits,
    configuredMonitorBatch(env),
    actual,
    settings?.max_workspaces ?? 10,
  );
}

function parseProductLimits(value: unknown): ProductLimits {
  const input = z
    .object({
      monitors: z.number().int().min(0).max(1000),
      regions: z.number().int().min(1).max(9),
      allowedRegionIds: z.array(z.string()).min(1).max(9),
    })
    .strict()
    .parse(value);
  const seen = new Set<string>();
  const allowedRegionIds: RegionId[] = [];
  for (const region of input.allowedRegionIds) {
    if (!isRegionId(region))
      throw new HttpErrorLike(400, 'region_invalid', `Unknown region: ${region}`);
    if (seen.has(region))
      throw new HttpErrorLike(
        400,
        'region_duplicate',
        `Region ${region} was listed more than once`,
      );
    seen.add(region);
    allowedRegionIds.push(region);
  }
  if (input.regions > allowedRegionIds.length)
    throw new HttpErrorLike(
      400,
      'region_limit_invalid',
      'The regions limit cannot exceed the number of allowed regions',
    );
  return { ...input, allowedRegionIds };
}

async function slotInventory(env: HostedRuntimeEnv) {
  const control = env.controlDb;
  const rows = await all<{
    binding_name: string;
    database_id: string;
    status: 'available' | 'assigned' | 'deleting' | 'quarantined';
    workspace_id: string | null;
    owner_handle: string | null;
    admission_enabled: number;
  }>(
    control,
    `SELECT r.source_database_id AS database_id,COALESCE(s.binding_name,r.source_database_id) AS binding_name,r.status,r.workspace_id, u.handle AS owner_handle, COALESCE(c.admission_enabled,1) AS admission_enabled
    FROM ${control.table('postgres_tenant_registry')} r LEFT JOIN ${control.table('tenant_slots')} s ON s.database_id=r.source_database_id
    LEFT JOIN ${control.table('tenant_slot_controls')} c ON c.binding_name=s.binding_name
    LEFT JOIN ${control.table('workspaces')} w ON w.id=r.workspace_id LEFT JOIN ${control.table('users')} u ON u.did=w.owner_did
    ORDER BY s.binding_name`,
  );
  const configured = rows.filter((slot) =>
    env.catalog.sources.some((source) => source.sourceDatabaseId === slot.database_id),
  );
  const publicSlots = rows.filter(
    (slot) => !isImportedSlot(env, slot.binding_name, slot.database_id),
  );
  const configuredPublicSlots = configured.filter(
    (slot) => !isImportedSlot(env, slot.binding_name, slot.database_id),
  );
  const settings = await first<{ max_workspaces: number }>(
    control,
    `SELECT max_workspaces FROM ${control.table('service_controls')} WHERE id=1`,
  );
  return {
    maxWorkspaces: settings?.max_workspaces ?? 10,
    configuredSlots: configuredPublicSlots.length,
    assignedSlots: publicSlots.filter((slot) => slot.status === 'assigned').length,
    availableSlots: configuredPublicSlots.filter(
      (slot) => slot.status === 'available' && !slot.workspace_id && slot.admission_enabled === 1,
    ).length,
    heldSlots: publicSlots.filter(
      (slot) => slot.status === 'available' && slot.admission_enabled === 0,
    ).length,
    quarantinedSlots: publicSlots.filter((slot) =>
      ['deleting', 'quarantined'].includes(slot.status),
    ).length,
    slots: rows.map((slot) => ({
      bindingName: slot.binding_name,
      databaseId: slot.database_id,
      status: slot.status,
      admissionEnabled: slot.admission_enabled === 1,
      workspaceId: slot.workspace_id,
      ownerHandle: slot.owner_handle,
      ...(isImportedSlot(env, slot.binding_name, slot.database_id)
        ? {
            kind: importedKind(
              env.catalog.sources.find((source) => source.sourceDatabaseId === slot.database_id)!,
            ),
          }
        : {}),
    })),
  };
}

function isImportedSlot(env: HostedRuntimeEnv, _bindingName: string, databaseId: string) {
  return env.catalog.sources.some(
    (source) => source.sourceDatabaseId === databaseId && source.profile !== 'full-hosted',
  );
}

async function operatorRequest(
  request: Request,
  env: HostedRuntimeEnv,
  principal: AtprotoPrincipal,
) {
  const control = env.controlDb;
  const path = new URL(request.url).pathname;
  if (path === '/api/operator/plans' && request.method === 'GET')
    return json(await readProductCatalog(control, parseApiEnv(env).enabledRegionIds));
  if (path === '/api/operator/plans' && request.method === 'PUT') {
    const input = z
      .object({
        expectedRevision: z.number().int().min(0),
        reason: z.string().trim().min(1).max(500),
        catalog: z.unknown(),
      })
      .parse(await readJson(request));
    const config = parseApiEnv(env);
    const catalog = validateProductCatalog(input.catalog, config.enabledRegionIds);
    if (
      (catalog.billingMode === 'mock' && config.environment === 'production') ||
      (catalog.billingMode === 'stripe' && !catalog.preview)
    ) {
      const readiness = await billingReadiness(
        { control, env, regions: config.enabledRegionIds },
        catalog,
      );
      if (!readiness.ready)
        throw new HttpErrorLike(400, 'billing_setup', readiness.setupReasons.join('; '));
    }
    return json(
      await saveProductCatalog(
        control,
        parseApiEnv(env).enabledRegionIds,
        input.catalog,
        input.expectedRevision,
        principal.did,
        input.reason,
      ),
    );
  }
  if (path === '/api/operator/cloudflare-usage' && request.method === 'GET')
    return json(
      await getCloudflareUsageReport({
        ...(typeof env.CLOUDFLARE_ACCOUNT_ID === 'string'
          ? { accountId: env.CLOUDFLARE_ACCOUNT_ID }
          : {}),
      }),
    );
  if (path === '/api/operator/health' && request.method === 'GET')
    return json(await operatorHealth(env, new URL(request.url), await budgetSummary(control, env)));
  const scheduling = path.match(/^\/api\/operator(?:\/workspaces\/([^/]+))?\/scheduling$/);
  if (scheduling && request.method === 'POST') {
    const input = z
      .object({ paused: z.boolean(), reason: z.string().trim().min(1).max(500) })
      .strict()
      .parse(await readJson(request));
    const id = scheduling[1] ? uuid.parse(scheduling[1]) : undefined;
    if (
      id &&
      !(await first(control, `SELECT id FROM ${control.table('workspaces')} WHERE id=$1`, [id]))
    )
      throw new HttpErrorLike(404, 'workspace_not_found', 'Workspace was not found');
    await setSchedulingPause(control, id ?? 'fleet', input.paused, input.reason, principal.did);
    return json({
      scheduling: await schedulingState(control, id, {
        ignoreBudget: budgetEnforcementDisabled(env),
      }),
    });
  }
  const preview = path.match(/^\/api\/operator\/workspaces\/([^/]+)\/limits\/preview$/);
  if (preview && request.method === 'POST') {
    const id = uuid.parse(preview[1]);
    if (await isImportedWorkspace(env, id))
      throw new HttpErrorLike(
        409,
        'limits_unsupported',
        'Imported workspaces are exempt from product quotas',
      );
    const input = parseProductLimits(await readJson(request));
    const configured = parseApiEnv(env).enabledRegionIds;
    if (input.allowedRegionIds.some((region) => !configured.includes(region)))
      throw new HttpErrorLike(400, 'region_unavailable', 'A requested region is not configured');
    return json({ capacity: await workspaceCapacity(env, id, input) });
  }
  if (path === '/api/operator/interest' && request.method === 'GET')
    return json(await interestList(control));
  if (path === '/api/operator/slots' && request.method === 'GET')
    return json(await slotInventory(env));
  if (path === '/api/operator/slots' && request.method === 'PATCH') {
    const input = z
      .object({
        maxWorkspaces: z.number().int().min(1).max(10),
      })
      .parse(await readJson(request));
    await control.transaction(async (tx) => {
      const updated = await run(
        tx,
        `UPDATE ${tx.table('service_controls')} SET max_workspaces=$1 WHERE id=1 AND max_workspaces<>$1`,
        [input.maxWorkspaces],
      );
      if (updated.rowCount) await audit(tx, null, principal.did, 'workspace_capacity', input);
    });
    return json(await slotInventory(env));
  }
  const slotAssignment = path.match(/^\/api\/operator\/slots\/([A-Z][A-Z0-9_]{0,63})\/assignment$/);
  if (slotAssignment && request.method === 'POST') {
    const bindingName = slotAssignment[1]!;
    const input = z.object({ ownerDid: didSchema }).parse(await readJson(request));
    const slot = await first<{
      binding_name: string;
      database_id: string;
      status: 'available' | 'assigned' | 'deleting';
      workspace_id: string | null;
    }>(
      control,
      `SELECT s.binding_name,r.source_database_id AS database_id,r.status,r.workspace_id FROM ${control.table('tenant_slots')} s JOIN ${control.table('postgres_tenant_registry')} r ON r.source_database_id=s.database_id WHERE s.binding_name=$1`,
      [bindingName],
    );
    if (!slot)
      throw new HttpErrorLike(409, 'slot_unavailable', 'Only an unused slot can be assigned');
    const source = env.catalog.sources.find(
      (source) => source.sourceDatabaseId === slot.database_id,
    );
    if (!source)
      throw new HttpErrorLike(
        409,
        'slot_unavailable',
        'Physical source is outside the runtime catalog',
      );
    const binding = scopePostgresDatabase(control, source);
    if (source.profile === 'legacy-production') {
      const identity = await first<{
        id: number;
        workspace_id: string;
        database_id: string;
        marker_count: number;
      }>(
        binding,
        `SELECT id,workspace_id,database_id,(SELECT count(*)::integer FROM ${binding.table(source.identityTable!)}) AS marker_count
         FROM ${binding.table(source.identityTable!)} WHERE id=1`,
      );
      if (
        identity?.id !== 1 ||
        identity.marker_count !== 1 ||
        identity.database_id !== source.sourceDatabaseId
      )
        throw new HttpErrorLike(
          409,
          'imported_identity_mismatch',
          'The production import marker is missing or invalid',
        );
      const markedWorkspace = await first<{ id: string; owner_did: string; role: string }>(
        control,
        `SELECT w.id,w.owner_did,m.role FROM ${control.table('workspaces')} w JOIN ${control.table('memberships')} m ON m.workspace_id=w.id
         WHERE w.id=$1 AND m.did=$2`,
        [identity.workspace_id, input.ownerDid],
      );
      if (
        !markedWorkspace ||
        markedWorkspace.owner_did !== input.ownerDid ||
        markedWorkspace.role !== 'owner'
      )
        throw new HttpErrorLike(
          409,
          'imported_owner_mismatch',
          'The production import must remain attached to its marked workspace owner',
        );
    }

    const user = await first<{ did: string; handle: string; state: string }>(
      control,
      `SELECT did,handle,state FROM ${control.table('users')} WHERE did=$1`,
      [input.ownerDid],
    );
    const interest = await first<{ did: string; handle: string }>(
      control,
      `SELECT did,handle FROM ${control.table('interest_signups')} WHERE did=$1`,
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

    const existing = await first<Workspace>(
      control,
      `SELECT * FROM ${control.table('workspaces')} WHERE owner_did=$1`,
      [input.ownerDid],
    );
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
        `SELECT s.binding_name FROM ${control.table('postgres_tenant_registry')} r JOIN ${control.table('tenant_slots')} s ON s.database_id=r.source_database_id WHERE r.workspace_id=$1 AND r.status='assigned'`,
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
      `INSERT INTO ${control.table('users')}(did,handle,state,created_at,updated_at,last_seen_at) VALUES($1,$2,'active',$3,$4,$5)
       ON CONFLICT(did) DO UPDATE SET handle=excluded.handle,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`,
      [input.ownerDid, ownerHandle, timestamp, timestamp, timestamp],
    );
    const workspace =
      existing ??
      (await first<Workspace>(
        control,
        `INSERT INTO ${control.table('workspaces')}(id,owner_did,name,state,plan,created_at,updated_at,last_seen_at,next_dispatch_at)
         VALUES($1,$2,$3,'waiting_for_capacity','free',$4,$5,$6,$7) ON CONFLICT(owner_did) DO UPDATE SET owner_did=excluded.owner_did RETURNING *`,
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
      `INSERT INTO ${control.table('memberships')}(workspace_id,did,role,created_at) VALUES($1,$2,'owner',$3) ON CONFLICT(workspace_id,did) DO NOTHING`,
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
        'The selected slot cannot be assigned while preserving capacity limits',
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
    const slot = await first<{ database_id: string }>(
      control,
      `SELECT database_id FROM ${control.table('tenant_slots')} WHERE binding_name=$1`,
      [bindingName],
    );
    if (
      !slot ||
      !env.catalog.sources.some((source) => source.sourceDatabaseId === slot.database_id)
    )
      throw new HttpErrorLike(
        409,
        'slot_unavailable',
        'Physical source is outside the runtime catalog',
      );
    if (isImportedSlot(env, bindingName, slot.database_id) && input.enabled)
      throw new HttpErrorLike(
        409,
        'explicit_assignment_required',
        'Imported data can only be assigned explicitly',
      );
    const updated = await control.transaction(async (tx) => {
      await first(tx, `SELECT id FROM ${tx.table('service_controls')} WHERE id=1 FOR UPDATE`);
      return first(
        tx,
        `INSERT INTO ${tx.table('tenant_slot_controls')}(binding_name,admission_enabled)
      SELECT s.binding_name, $1::integer FROM ${tx.table('tenant_slots')} s JOIN ${tx.table('postgres_tenant_registry')} r ON r.source_database_id=s.database_id WHERE s.binding_name=$2 AND r.status='available' AND r.workspace_id IS NULL
      AND ($3::integer = 1 OR (SELECT count(*) FROM ${tx.table('postgres_tenant_registry')} r2
        JOIN ${tx.table('tenant_slots')} s2 ON s2.database_id=r2.source_database_id
        WHERE r2.status='available' AND r2.workspace_id IS NULL AND NOT (s2.binding_name = ANY($5::text[]))
        AND r2.source_database_id = ANY($6::text[])
        AND COALESCE((SELECT admission_enabled FROM ${tx.table('tenant_slot_controls')} c WHERE c.binding_name=s2.binding_name),1)=1) > $4)
      ON CONFLICT(binding_name) DO UPDATE SET admission_enabled=excluded.admission_enabled RETURNING binding_name`,
        [
          input.enabled ? 1 : 0,
          bindingName,
          input.enabled ? 1 : 0,
          minimumAvailableSlots(env),
          reservedSlotNames(env),
          env.catalog.sources
            .filter((source) => source.profile === 'full-hosted')
            .map((source) => source.sourceDatabaseId),
        ],
      );
    });
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
       FROM ${control.table('workspaces')} w JOIN ${control.table('users')} u ON u.did = w.owner_did LEFT JOIN ${control.table('workspace_usage_daily')} d ON d.workspace_id = w.id AND d.day >= $1 GROUP BY w.id,u.handle ORDER BY w.created_at DESC LIMIT 100`,
      [new Date().toISOString().slice(0, 7) + '-01'],
    );
    const configuredRegionIds = parseApiEnv(env).enabledRegionIds;
    return json({
      availableRegions: parseApiEnv(env).enabledRegions,
      workspaces: await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          name: row.name,
          state: row.state,
          ownerDid: row.owner_did,
          ownerHandle: row.owner_handle,
          monitorCount: (await workspaceUsage(env, row))?.monitors ?? 0,
          limits: await operatorWorkspaceLimits(env, row, configuredRegionIds),
          rowsRead: null,
          rowsWritten: null,
          storageBytes: null,
          historicalD1Usage: {
            rowsRead: Number(row.rows_read),
            rowsWritten: Number(row.rows_written),
            storageBytes: Number(row.storage_bytes),
          },
          lastSeenAt: row.last_seen_at,
        })),
      ),
      budget: await budgetSummary(control, env),
    });
  }
  const productLimits = path.match(/^\/api\/operator\/workspaces\/([^/]+)\/limits$/);
  if (productLimits && request.method === 'PATCH') {
    const id = uuid.parse(productLimits[1]);
    const input = parseProductLimits(await readJson(request));
    const configuredRegionIds = parseApiEnv(env).enabledRegionIds;
    const unavailable = input.allowedRegionIds.find(
      (region) => !configuredRegionIds.includes(region),
    );
    if (unavailable)
      throw new HttpErrorLike(
        400,
        'region_unavailable',
        `Region ${unavailable} is not configured for this deployment`,
      );
    const workspace = await first<Workspace>(
      control,
      `SELECT * FROM ${control.table('workspaces')} WHERE id = $1`,
      [id],
    );
    if (!workspace) throw new HttpErrorLike(404, 'workspace_not_found', 'Workspace was not found');
    if (await isImportedWorkspace(env, id))
      throw new HttpErrorLike(
        409,
        'limits_unsupported',
        'Product limits are not supported for imported monitor workspaces',
      );
    if (workspace.state === 'waiting_for_capacity') {
      return control.transaction(async (tx) => {
        // Provisioning takes the same row lock before assigning a tenant.
        const current = await first<Workspace & { execution_lease_until: string | null }>(
          tx,
          `SELECT * FROM ${tx.table('workspaces')} WHERE id=$1 FOR NO KEY UPDATE`,
          [id],
        );
        if (current?.state !== 'waiting_for_capacity')
          throw new HttpErrorLike(
            409,
            'workspace_busy',
            'Workspace state changed. Refresh before editing limits',
          );
        if (
          current.execution_lease_until &&
          current.execution_lease_until > new Date().toISOString()
        )
          throw new HttpErrorLike(
            409,
            'workspace_busy',
            'Workspace is processing another operation. Try again shortly',
          );
        const capacity = await workspaceCapacity({ ...env, controlDb: tx }, id, input);
        if (!capacity.safe)
          throw new HttpErrorLike(409, 'capacity_exceeded', capacity.warnings.join('; '));
        await run(
          tx,
          `INSERT INTO ${tx.table('workspace_product_limits')}(workspace_id,monitors,regions,allowed_region_ids,updated_at)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(workspace_id) DO UPDATE SET monitors=excluded.monitors,
             regions=excluded.regions,allowed_region_ids=excluded.allowed_region_ids,updated_at=excluded.updated_at`,
          [
            id,
            input.monitors,
            input.regions,
            JSON.stringify(input.allowedRegionIds),
            new Date().toISOString(),
          ],
        );
        await audit(tx, id, principal.did, 'workspace_product_limits', input);
        return json({ limits: productLimitsResponse(input) });
      });
    }
    if (!['active', 'suspended'].includes(workspace.state))
      throw new HttpErrorLike(
        409,
        'workspace_unprovisioned',
        'Product limits require a provisioned hosted workspace',
      );
    const slot = await first<{ binding_name: string }>(
      control,
      `SELECT source_database_id FROM ${control.table('postgres_tenant_registry')} WHERE workspace_id = $1 AND status = 'assigned'`,
      [id],
    );
    if (!slot)
      throw new HttpErrorLike(
        409,
        'workspace_unprovisioned',
        'Product limits require a provisioned hosted workspace',
      );

    return withWorkspaceWriteLease(
      control,
      id,
      async () => {
        const capacity = await workspaceCapacity(env, id, input);
        if (!capacity.safe)
          throw new HttpErrorLike(409, 'capacity_exceeded', capacity.warnings.join('; '));
        return withWorkspacePolicy(env, id, async (control, db) => {
          const previous = await savedWorkspaceProductLimits(control, id, configuredRegionIds);
          await syncWorkspaceProductLimits(db, previous);
          const counts = await first<{ monitors: number }>(
            db,
            `SELECT count(*)::integer AS monitors FROM ${db.table('monitors')}`,
          );
          if (Number(counts?.monitors ?? 0) > input.monitors)
            throw new HttpErrorLike(
              409,
              'limits_conflict',
              `This workspace already has ${counts?.monitors ?? 0} saved monitors. Remove monitors before lowering the limit to ${input.monitors}`,
            );
          // Stale rows must survive while the operator grants replacement regions.
          const conflictingMonitor = await first<{
            id: string;
            configured_region_count: number;
            configured_disallowed_count: number;
          }>(
            db,
            `SELECT m.id,
                  count(*) FILTER (WHERE mr.region_id=ANY($1::text[]))::integer AS configured_region_count,
                  count(*) FILTER (WHERE mr.region_id=ANY($1::text[]) AND NOT (mr.region_id=ANY($2::text[])))::integer AS configured_disallowed_count
           FROM ${db.table('monitors')} m LEFT JOIN ${db.table('monitor_regions')} mr ON mr.monitor_id = m.id
           GROUP BY m.id
           HAVING count(*) FILTER (WHERE mr.region_id=ANY($1::text[])) > $3 OR count(*) FILTER (WHERE mr.region_id=ANY($1::text[]) AND NOT (mr.region_id=ANY($2::text[]))) > 0
           LIMIT 1`,
            [configuredRegionIds, input.allowedRegionIds, input.regions],
          );
          if (conflictingMonitor)
            throw new HttpErrorLike(
              409,
              'limits_conflict',
              `Saved monitor ${conflictingMonitor.id} uses ${conflictingMonitor.configured_region_count} configured regions or a region outside the new policy. Update its regions before lowering this limit`,
            );

          const saved = await first<{
            monitors: number;
            regions: number;
            allowed_region_ids: string;
          }>(
            control,
            `SELECT monitors,regions,allowed_region_ids FROM ${control.table('workspace_product_limits')} WHERE workspace_id=$1`,
            [id],
          );
          if (
            saved &&
            saved.monitors === input.monitors &&
            saved.regions === input.regions &&
            saved.allowed_region_ids === JSON.stringify(input.allowedRegionIds)
          )
            return json({ limits: productLimitsResponse(input) });
          await syncWorkspaceProductLimits(db, input);
          await run(
            control,
            `INSERT INTO ${control.table('workspace_product_limits')}(workspace_id,monitors,regions,allowed_region_ids,updated_at)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT(workspace_id) DO UPDATE SET monitors=excluded.monitors,
               regions=excluded.regions, allowed_region_ids=excluded.allowed_region_ids,
               updated_at=excluded.updated_at`,
            [
              id,
              input.monitors,
              input.regions,
              JSON.stringify(input.allowedRegionIds),
              new Date().toISOString(),
            ],
          );
          await audit(control, id, principal.did, 'workspace_product_limits', input);
          return json({ limits: productLimitsResponse(input) });
        });
      },
      true,
    );
  }
  const state = path.match(/^\/api\/operator\/workspaces\/([^/]+)\/state$/);
  if (state && request.method === 'POST') {
    const id = uuid.parse(state[1]);
    const input = z
      .object({ state: z.enum(['active', 'suspended']), reason: z.string().trim().min(1).max(500) })
      .parse(await readJson(request));
    const workspace = await first<Workspace>(
      control,
      `SELECT * FROM ${control.table('workspaces')} WHERE id = $1`,
      [id],
    );
    if (
      workspace &&
      ['active', 'suspended'].includes(workspace.state) &&
      workspace.state === input.state
    )
      return json({ id, state: input.state });
    if (workspace?.state === 'waiting_for_capacity' && input.state === 'active') {
      const provisioned = await provisionWorkspace(env, workspace, { operatorActivation: true });
      if (provisioned.state !== 'active')
        throw new HttpErrorLike(
          409,
          'capacity_unavailable',
          'Activation needs an available database slot and space under the workspace limit.',
        );
      await audit(control, id, principal.did, 'workspace_state', input);
      return json({ id, state: provisioned.state });
    }
    const updated = await first(
      control,
      `UPDATE ${control.table('workspaces')} SET state = $1, updated_at = $2 WHERE id = $3 AND state IN ('active','suspended') AND state<>$1 RETURNING id`,
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
    await control.transaction(async (tx) => {
      const updated = await run(
        tx,
        `UPDATE ${tx.table('service_controls')} SET admission_open=$1,external_monthly_cost_usd=$2 WHERE id=1 AND (admission_open<>$1 OR external_monthly_cost_usd<>$2)`,
        [input.admissionOpen ? 1 : 0, input.externalMonthlyCostUsd],
      );
      if (updated.rowCount) await audit(tx, null, principal.did, 'service_controls', input);
    });
    return json({ budget: await budgetSummary(control, env) });
  }
  throw new HttpErrorLike(404, 'not_found', 'Operator endpoint was not found');
}

async function audit(
  control: Database,
  workspaceId: string | null,
  did: string,
  event: string,
  details: unknown,
) {
  await run(
    control,
    `INSERT INTO ${control.table('workspace_events')}(id,workspace_id,event,actor_did,created_at,details) VALUES($1,$2,$3,$4,$5,$6)`,
    [randomId(), workspaceId, event, did, new Date().toISOString(), JSON.stringify(details)],
  );
}

async function workspaceRequest(
  request: Request,
  env: HostedRuntimeEnv,
  principal: AtprotoPrincipal,
  workspace: Workspace,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const control = env.controlDb;
  if (path === '/api/workspace/usage' && request.method === 'GET')
    return json({
      usage: await workspaceUsage(env, workspace),
      limits: (await isImportedWorkspace(env, workspace.id))
        ? null
        : productLimitsResponse(await getWorkspaceProductLimits(env, workspace.id)),
      budget: await budgetSummary(control, env),
    });
  if (path === '/api/workspace/members' && request.method === 'GET')
    return json({
      members: await all(
        control,
        `SELECT m.did, u.handle, m.role, m.created_at AS "createdAt" FROM ${control.table('memberships')} m JOIN ${control.table('users')} u ON u.did = m.did WHERE workspace_id = $1`,
        [workspace.id],
      ),
      invitations:
        workspace.role === 'owner'
          ? (
              await listWorkspaceInvitations(control, {
                workspaceId: workspace.id,
                actorDid: principal.did,
              })
            ).invitations
          : [],
    });
  const accept = path.match(/^\/api\/workspace\/invitations\/([^/]+)\/accept$/);
  if (accept && request.method === 'POST') {
    return json(
      await acceptWorkspaceInvitation(control, {
        invitationId: uuid.parse(accept[1]),
        principalDid: principal.did,
      }),
    );
  }
  const invitationAction = path.match(/^\/api\/workspace\/invitations\/([^/]+)(\/resend)?$/);
  if (
    invitationAction &&
    ((request.method === 'POST' && invitationAction[2]) ||
      (request.method === 'DELETE' && !invitationAction[2]))
  ) {
    ownerOnly(workspace);
    const options = {
      workspaceId: workspace.id,
      invitationId: uuid.parse(invitationAction[1]),
      actorDid: principal.did,
    };
    return json(
      request.method === 'POST'
        ? await resendWorkspaceInvitation(control, options)
        : await revokeWorkspaceInvitation(control, options),
    );
  }
  if (path === '/api/workspace/invitations' && request.method === 'POST') {
    ownerOnly(workspace);
    const input = z
      .object({ did: didSchema, role: z.enum(['maintainer', 'viewer']) })
      .parse(await readJson(request));
    return json(
      await createWorkspaceInvitation(control, {
        workspaceId: workspace.id,
        actorDid: principal.did,
        inviteeDid: input.did,
        role: input.role,
      }),
      { status: 201 },
    );
  }
  const member = path.match(/^\/api\/workspace\/members\/(.+)$/);
  if (member && request.method === 'DELETE') {
    ownerOnly(workspace);
    const did = didSchema.parse(decodeURIComponent(member[1]!));
    if (did === workspace.owner_did)
      throw new HttpErrorLike(409, 'owner_required', 'The owner cannot be removed');
    await control.transaction(async (tx) => {
      await first(tx, `SELECT id FROM ${tx.table('workspaces')} WHERE id=$1 FOR NO KEY UPDATE`, [
        workspace.id,
      ]);
      const removed = await run(
        tx,
        `DELETE FROM ${tx.table('memberships')} WHERE workspace_id=$1 AND did=$2`,
        [workspace.id, did],
      );
      const revoked = await run(
        tx,
        `DELETE FROM ${tx.table('workspace_invitations')} WHERE workspace_id=$1 AND invitee_did=$2`,
        [workspace.id, did],
      );
      if (removed.rowCount || revoked.rowCount)
        await audit(tx, workspace.id, principal.did, 'member_removed', { did });
    });
    return json({ removed: true });
  }
  if (path === '/api/workspace' && request.method === 'DELETE') {
    ownerOnly(workspace);
    if (await isImportedWorkspace(env, workspace.id))
      throw new HttpErrorLike(
        409,
        'imported_data_protected',
        'Imported history cannot be deleted through workspace settings',
      );
    await run(
      control,
      `UPDATE ${control.table('workspaces')} SET state = 'deleting', updated_at = $1 WHERE id = $2 AND state <> 'deleted'`,
      [new Date().toISOString(), workspace.id],
    );
    const complete = await purgeWorkspaceData(
      {
        controlDb: control,
        catalog: env.catalog.sources,
        ...(env.REPORTS ? { REPORTS: env.REPORTS } : {}),
      },
      workspace.id,
    );
    return json({ state: complete ? 'deleted' : 'deleting' }, { status: complete ? 200 : 202 });
  }
  if (workspace.state !== 'active')
    throw new HttpErrorLike(403, 'workspace_unavailable', 'Workspace is not active');
  const db = await activeDatabase(env, workspace.id);
  if (path === '/api/workspace/export' && request.method === 'GET') {
    ownerOnly(workspace);
    const imported = await isImportedWorkspace(env, workspace.id);
    // Credential material, OAuth tokens and private delivery payloads never leave through exports.
    return json({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: { id: workspace.id, name: workspace.name },
      monitors: await all(db, `SELECT * FROM ${db.table('monitors')} LIMIT 1000`),
      regions: await all(db, `SELECT * FROM ${db.table('monitor_regions')}`),
      statusPages: await all(db, `SELECT * FROM ${db.table('status_pages')} LIMIT 1000`),
      groups: await all(db, `SELECT * FROM ${db.table('status_page_groups')}`),
      pageMonitors: await all(db, `SELECT * FROM ${db.table('status_page_monitors')}`),
      uptime: await all(
        db,
        `SELECT * FROM ${db.table('monitor_daily_uptime')} ORDER BY day DESC LIMIT 90`,
      ),
      destinations: await all(
        db,
        `SELECT id,name,provider,enabled FROM ${db.table('notification_services')} LIMIT 1000`,
      ),
    });
  }
  if (mutation(request) && workspace.role === 'viewer')
    throw new HttpErrorLike(403, 'forbidden', 'Viewer access is read only');
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

async function enforceHostedRequest(
  request: Request,
  db: Database,
  limits: ProductLimits | undefined,
  configuredRegionIds: readonly RegionId[],
) {
  const url = new URL(request.url);
  if (url.pathname.includes('/dns-diagnostics'))
    throw new HttpErrorLike(403, 'free_limit', 'DNS diagnostics are unavailable in this release');
  if (!mutation(request)) return;
  if (!limits) throw new Error('Hosted product policy was not loaded before a mutation');
  const body = (await readJson(request.clone() as unknown as Request)) as
    Record<string, unknown> | undefined;
  if (body && url.pathname.startsWith('/api/monitors') && request.method !== 'DELETE') {
    const requestedRegions = body.regionIds;
    if (Array.isArray(requestedRegions)) {
      if (requestedRegions.length > limits.regions)
        throw new HttpErrorLike(
          409,
          'region_limit',
          `This workspace allows up to ${limits.regions} regions per monitor`,
        );
      const distinctRegions = new Set<string>();
      const availableAllowedRegions = new Set(
        limits.allowedRegionIds.filter((region) => configuredRegionIds.includes(region)),
      );
      for (const value of requestedRegions) {
        if (typeof value !== 'string' || !isRegionId(value))
          throw new HttpErrorLike(400, 'region_invalid', `Unknown region: ${String(value)}`);
        if (distinctRegions.has(value))
          throw new HttpErrorLike(
            400,
            'region_duplicate',
            `Region ${value} was listed more than once`,
          );
        if (!availableAllowedRegions.has(value))
          throw new HttpErrorLike(
            400,
            'region_unavailable',
            `Region ${value} is not configured and allowed for this workspace`,
          );
        distinctRegions.add(value);
      }
    }
    if (
      (body.intervalSeconds !== undefined && body.intervalSeconds !== 300) ||
      (body.timeoutMs !== undefined && Number(body.timeoutMs) > 10000) ||
      body.dnsDiagnosticsEnabled === true ||
      (body.outageThreshold !== undefined && body.outageThreshold !== 2) ||
      (body.recoveryThreshold !== undefined && body.recoveryThreshold !== 1) ||
      body.repeatNotificationMinutes != null
    )
      throw new HttpErrorLike(
        400,
        'free_limit',
        `Hosted monitors use five-minute checks, up to ${limits.regions} regions, ten-second timeouts, two failed rounds and one recovery round`,
      );
    if (typeof body.url === 'string') {
      monitorUrl(body.url);
    }
    if (request.method === 'POST' && url.pathname === '/api/monitors') {
      const current = await first<{ count: number }>(
        db,
        `SELECT count(*)::integer AS count FROM ${db.table('monitors')}`,
      );
      if (Number(current?.count ?? 0) >= limits.monitors)
        throw new HttpErrorLike(
          409,
          'monitor_limit',
          `This workspace already has ${current?.count ?? 0} saved monitors, its limit is ${limits.monitors}`,
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
  env: HostedRuntimeEnv,
  workspaceId: string,
  db: Database,
) {
  const url = new URL(request.url);
  const monitorMatch = /^\/reports\/public\/monitors\/([A-Za-z0-9.-]+)\.json$/.exec(url.pathname);
  if (monitorMatch) {
    const monitor = await getPublicMonitor(db, monitorMatch[1]!);
    if (!monitor) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    const body = await monitorRequestCache.get(
      JSON.stringify([workspaceId, db.schema, 'report', monitor.id, monitor.updated_at]),
      async () => {
        const now = new Date();
        const [summary, uptime, ...latencies] = await Promise.all([
          monitorSummary(db, monitor, log),
          monitorUptimePayload(db, monitor.id, now),
          ...(['1h', '24h', '7d', '30d'] as const).map((range) =>
            latencyPayload(db, monitor.id, range, now),
          ),
        ]);
        const latestObservationAt = Object.values(summary.latestByRegion).reduce<string | null>(
          (latest, item) =>
            item && (!latest || item.startedAt > latest) ? item.startedAt : latest,
          null,
        );
        return {
          schemaVersion: '1',
          generatedAt: now.toISOString(),
          staleAfterSeconds: 60,
          latestObservationAt,
          summary: toPublicMonitorSummary(
            !latestObservationAt || now.getTime() - Date.parse(latestObservationAt) > 420_000
              ? { ...summary, status: 'unknown' }
              : summary,
          ),
          uptime,
          latency: latencies[1],
          latencyByRange: Object.fromEntries(
            ['1h', '24h', '7d', '30d'].map((range, index) => [range, latencies[index]]),
          ),
        };
      },
    );
    if (!(await getPublicMonitor(db, monitorMatch[1]!)))
      throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json(body);
  }
  if (!env.REPORTS) throw new HttpErrorLike(503, 'reports_unavailable', 'Reports are unavailable');
  const imported = await isImportedWorkspace(env, workspaceId);
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
      `SELECT id, public_slug FROM ${db.table('status_pages')} ORDER BY created_at,id LIMIT 1000`,
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
