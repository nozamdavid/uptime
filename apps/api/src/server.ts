import { createHmac, randomBytes } from 'node:crypto';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { apiEnvSchema, regionById, regions, type ApiEnv } from '@uptime/config';
import {
  calculateTargetChecksPerDay,
  estimateRequestSchema,
  monitorCreateSchema,
  monitorUpdateSchema,
  regionIdSchema,
  type Monitor,
  type MonitorSummary,
  type Observation,
  type PublicMonitorSummary,
  type RegionId,
} from '@uptime/contracts';
import { createDatabase, type Database } from '@uptime/database';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { assertResolvablePublicHttpUrl, UrlPolicyError } from './security.js';
import { deriveAggregateStatus, type LatestObservation } from './status.js';
import { assertValidAdminPasswordHash, verifyAdminPassword } from './auth.js';
import { parseStoredEndpointEvidence, type EndpointEvidenceLog } from './endpoint-evidence.js';
import { parseStoredDnsDiagnostic, type DnsDiagnosticLog } from './dns-diagnostics.js';

const sessionCookie = 'uptime_session';
const ranges = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
} as const;
export const latencyBucketIntervals = {
  '1h': '5 minutes',
  '24h': '15 minutes',
  '7d': '1 hour',
  '30d': '6 hours',
} as const;
const rangeSchema = z.enum(['1h', '24h', '7d', '30d']).default('24h');
const diagnosticRangeSchema = z.enum(['7d', '30d']).default('7d');
// With zero trusted proxy hops, requests arriving through a proxy share its direct
// address. Deployments can opt into the exact number of known hops in front of the API.
const publicMonitorRateLimit = { max: 30, timeWindow: '1 minute' };
const idSchema = z.object({ id: z.uuid() });
const cursorSchema = z.object({ startedAt: z.string().datetime(), id: z.uuid() });
export const observationListQuerySchema = z.object({
  range: rangeSchema,
  regionId: regionIdSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const dnsDiagnosticCursorSchema = z.object({ requestedAt: z.string().datetime(), id: z.uuid() });
export const dnsDiagnosticListQuerySchema = z.object({
  range: diagnosticRangeSchema,
  regionId: regionIdSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface SessionAdmin {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: SessionAdmin | null;
  }
}

export interface ApiDependencies {
  db?: Database;
  now?: () => Date;
}

export async function buildApi(
  source: Record<string, unknown>,
  dependencies: ApiDependencies = {},
) {
  const env = apiEnvSchema.parse(source) as ApiEnv;
  await assertValidAdminPasswordHash(env.ADMIN_PASSWORD_HASH);
  const ownedDatabase = dependencies.db === undefined;
  const database = dependencies.db
    ? { db: dependencies.db, close: async () => undefined }
    : createDatabase(env.DATABASE_URL);
  const now = dependencies.now ?? (() => new Date());
  // Fastify 5.12 fails closed for numeric trustProxy values. Use its function
  // form so this setting still means exactly N hops, starting at the direct peer.
  const trustProxy =
    env.API_TRUST_PROXY_HOPS === 0
      ? false
      : (_address: string, hop: number) => hop < env.API_TRUST_PROXY_HOPS;
  const app = Fastify({ logger: true, trustProxy });

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('admin', null);
  app.addHook('onReady', async () => {
    await database.db.execute(sql`
      insert into admins (email, password_hash)
      values (${env.ADMIN_EMAIL}, ${env.ADMIN_PASSWORD_HASH})
      on conflict (singleton_key) do nothing
    `);
  });
  app.addHook('preHandler', async (request) => {
    const token = request.cookies[sessionCookie];
    if (!token) return;
    const hash = hashSessionToken(token, env.SESSION_SECRET);
    const found = await rows<SessionAdmin>(
      database.db,
      sql`
        select admins.id, admins.email
        from sessions join admins on admins.id = sessions.admin_id
        where sessions.token_hash = ${hash} and sessions.expires_at > now()
        limit 1
      `,
    );
    request.admin = found[0] ?? null;
  });
  app.setErrorHandler((error, _request, reply) => {
    const apiException = error as Partial<{
      isApiError: boolean;
      statusCode: number;
      code: string;
      message: string;
    }>;
    if (apiException.isApiError) {
      return reply
        .code(apiException.statusCode ?? 500)
        .send(
          apiError(
            apiException.code ?? 'internal_error',
            apiException.message ?? 'Unexpected server error',
          ),
        );
    }
    if (error instanceof UrlPolicyError) {
      return reply.code(400).send(apiError(error.code, error.message));
    }
    if (error instanceof z.ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const key = issue.path.join('.') || 'body';
        (fieldErrors[key] ??= []).push(issue.message);
      }
      return reply
        .code(400)
        .send(apiError('validation_error', 'Request validation failed', fieldErrors));
    }
    app.log.error(error);
    return reply.code(500).send(apiError('internal_error', 'Unexpected server error'));
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z.object({ password: z.string().min(1).max(1024) }).parse(request.body);
      const found = await rows<{ id: string; email: string; passwordHash: string }>(
        database.db,
        sql`select id, email, password_hash as "passwordHash" from admins limit 1`,
      );
      const admin = found[0];
      if (!admin) {
        return reply.code(401).send(apiError('invalid_credentials', 'Invalid password'));
      }
      const verification = await verifyAdminPassword(admin.passwordHash, body.password);
      if (!verification.hashIsValid) {
        request.log.error(
          { authConfiguration: 'malformed_admin_password_hash' },
          'Admin password hash is malformed',
        );
        return reply
          .code(500)
          .send(apiError('auth_configuration_error', 'Authentication is temporarily unavailable'));
      }
      if (!verification.matches)
        return reply.code(401).send(apiError('invalid_credentials', 'Invalid password'));
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now().getTime() + env.SESSION_TTL_SECONDS * 1_000);
      await database.db.execute(sql`
      insert into sessions (admin_id, token_hash, expires_at)
      values (${admin.id}, ${hashSessionToken(token, env.SESSION_SECRET)}, ${expiresAt.toISOString()})
    `);
      reply.setCookie(sessionCookie, token, sessionCookieOptions(env, expiresAt));
      return { admin: { id: admin.id, email: admin.email }, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) {
      await database.db.execute(
        sql`delete from sessions where token_hash = ${hashSessionToken(token, env.SESSION_SECRET)}`,
      );
    }
    reply.clearCookie(sessionCookie, sessionCookieOptions(env));
    return reply.code(204).send();
  });

  app.get('/api/auth/session', async (request) => {
    if (!request.admin) throw httpError(401, 'unauthorized', 'Authentication is required');
    return { admin: request.admin };
  });

  app.get('/api/regions', async () => ({ regions }));
  app.post('/api/estimates', async (request) =>
    calculateTargetChecksPerDay(estimateRequestSchema.parse(request.body)),
  );

  app.get('/api/monitors', async (request) => {
    requireAdmin(request);
    const monitorRows = await rows<MonitorRow>(
      database.db,
      sql`
      select id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled,
        dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic",
        created_at as "createdAt", updated_at as "updatedAt"
      from monitors order by created_at desc
    `,
    );
    return {
      monitors: await Promise.all(
        monitorRows.map((row) => monitorSummary(database.db, row, app.log)),
      ),
    };
  });

  app.post('/api/monitors', async (request, reply) => {
    requireAdmin(request);
    const input = monitorCreateSchema.parse(request.body);
    await assertResolvablePublicHttpUrl(input.url);
    const created = await database.db.transaction(async (tx) => {
      const nextCheckAt = nextBoundary(now(), input.intervalSeconds);
      const inserted = await rows<MonitorRow>(
        tx,
        sql`
        insert into monitors (name, url, interval_seconds, timeout_ms, enabled, dns_diagnostics_enabled, is_public, next_check_at)
        values (${input.name ?? null}, ${input.url}, ${input.intervalSeconds}, ${input.timeoutMs}, ${input.enabled}, ${input.dnsDiagnosticsEnabled}, ${input.isPublic}, ${nextCheckAt.toISOString()})
        returning id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled,
          dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic",
          created_at as "createdAt", updated_at as "updatedAt"
      `,
      );
      const monitor = inserted[0];
      if (!monitor) throw new Error('Monitor insert did not return a row');
      for (const regionId of input.regionIds) {
        await tx.execute(
          sql`insert into monitor_regions (monitor_id, region_id) values (${monitor.id}, ${regionId})`,
        );
      }
      return monitor;
    });
    return reply
      .code(201)
      .send({ summary: await monitorSummary(database.db, created, request.log) });
  });

  app.get('/api/monitors/:id', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const monitor = await getMonitor(database.db, id);
    if (!monitor) throw httpError(404, 'not_found', 'Monitor was not found');
    return { summary: await monitorSummary(database.db, monitor, request.log) };
  });

  app.get(
    '/api/monitors/public/:id',
    { config: { rateLimit: publicMonitorRateLimit } },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const monitor = await getPublicMonitor(database.db, id);
      if (!monitor) throw httpError(404, 'not_found', 'Monitor was not found');
      return {
        summary: toPublicMonitorSummary(await monitorSummary(database.db, monitor, request.log)),
      };
    },
  );

  app.patch('/api/monitors/:id', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const current = await getMonitor(database.db, id);
    if (!current) throw httpError(404, 'not_found', 'Monitor was not found');
    const update = monitorUpdateSchema.parse(request.body);
    const currentRegionIds = await getRegionIds(database.db, id);
    const merged = monitorCreateSchema.parse({
      name: current.name ?? undefined,
      url: current.url,
      regionIds: currentRegionIds,
      intervalSeconds: current.intervalSeconds,
      timeoutMs: current.timeoutMs,
      enabled: current.enabled,
      dnsDiagnosticsEnabled: current.dnsDiagnosticsEnabled,
      isPublic: current.isPublic,
      ...update,
    });
    await assertResolvablePublicHttpUrl(merged.url);
    const updated = await database.db.transaction(async (tx) => {
      const nextCheckAt = update.intervalSeconds
        ? nextBoundary(now(), merged.intervalSeconds)
        : undefined;
      const changed = await rows<MonitorRow>(
        tx,
        sql`
        update monitors set
          name = ${merged.name ?? null}, url = ${merged.url}, interval_seconds = ${merged.intervalSeconds},
          timeout_ms = ${merged.timeoutMs}, enabled = ${merged.enabled},
          dns_diagnostics_enabled = ${merged.dnsDiagnosticsEnabled},
          is_public = ${merged.isPublic},
          next_check_at = coalesce(${nextCheckAt?.toISOString() ?? null}, next_check_at), updated_at = now()
        where id = ${id}
        returning id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled,
          dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic",
          created_at as "createdAt", updated_at as "updatedAt"
      `,
      );
      if (update.regionIds) {
        await tx.execute(sql`delete from monitor_regions where monitor_id = ${id}`);
        for (const regionId of merged.regionIds) {
          await tx.execute(
            sql`insert into monitor_regions (monitor_id, region_id) values (${id}, ${regionId})`,
          );
        }
      }
      const row = changed[0];
      if (!row) throw httpError(404, 'not_found', 'Monitor was not found');
      return row;
    });
    return { summary: await monitorSummary(database.db, updated, request.log) };
  });

  app.delete('/api/monitors/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const deleted = await rows<{ id: string }>(
      database.db,
      sql`delete from monitors where id = ${id} returning id`,
    );
    if (deleted.length === 0) throw httpError(404, 'not_found', 'Monitor was not found');
    return reply.code(204).send();
  });

  app.get('/api/monitors/:id/latency', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const { range } = z.object({ range: rangeSchema }).parse(request.query);
    const monitor = await getMonitor(database.db, id);
    if (!monitor) throw httpError(404, 'not_found', 'Monitor was not found');
    return latencyPayload(database.db, id, range, now);
  });

  app.get(
    '/api/monitors/public/:id/latency',
    { config: { rateLimit: publicMonitorRateLimit } },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const { range } = z.object({ range: rangeSchema }).parse(request.query);
      if (!(await getPublicMonitor(database.db, id))) {
        throw httpError(404, 'not_found', 'Monitor was not found');
      }
      return latencyPayload(database.db, id, range, now);
    },
  );

  app.get('/api/monitors/:id/observations', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const query = observationListQuerySchema.parse(request.query);
    if (!(await getMonitor(database.db, id)))
      throw httpError(404, 'not_found', 'Monitor was not found');
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const since = new Date(now().getTime() - ranges[query.range]);
    const cursorCondition = cursor
      ? sql`and (started_at, id) < (${new Date(cursor.startedAt).toISOString()}, ${cursor.id})`
      : sql``;
    const regionCondition = query.regionId ? sql`and region_id = ${query.regionId}` : sql``;
    const observations = await rows<ObservationRow>(
      database.db,
      sql`
      select id, check_run_id as "checkRunId", monitor_id as "monitorId", region_id as "regionId", status,
        success, http_status as "httpStatus", response_ms as "responseMs", total_ms as "totalMs",
        error_code as "errorCode", error_detail as "errorDetail", placement, colo, final_url as "finalUrl",
        endpoint_evidence as "endpointEvidence",
        redirect_count as "redirectCount", body_bytes as "bodyBytes", probe_version as "probeVersion",
        started_at as "startedAt", completed_at as "completedAt"
      from observations where monitor_id = ${id} and started_at >= ${since.toISOString()} ${regionCondition} ${cursorCondition}
      order by started_at desc, id desc limit ${query.limit + 1}
    `,
    );
    const hasMore = observations.length > query.limit;
    const page = observations
      .slice(0, query.limit)
      .map((observation) => serializeObservation(observation, request.log));
    const last = page.at(-1);
    return {
      observations: page,
      nextCursor: hasMore && last ? encodeCursor({ startedAt: last.startedAt, id: last.id }) : null,
    };
  });

  app.get('/api/monitors/:id/dns-diagnostics', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const query = dnsDiagnosticListQuerySchema.parse(request.query);
    if (!(await getMonitor(database.db, id)))
      throw httpError(404, 'not_found', 'Monitor was not found');
    const cursor = query.cursor ? decodeDnsDiagnosticCursor(query.cursor) : null;
    const since = new Date(now().getTime() - ranges[query.range]);
    const regionCondition = query.regionId ? sql`and region_id = ${query.regionId}` : sql``;
    const cursorCondition = cursor
      ? sql`and (requested_at, id) < (${new Date(cursor.requestedAt).toISOString()}, ${cursor.id})`
      : sql``;
    const diagnostics = await rows<DnsDiagnosticRow>(
      database.db,
      sql`
        select id, monitor_id as "monitorId", check_run_id as "checkRunId", observation_id as "observationId",
          region_id as "regionId", kind, window_started_at as "windowStartedAt", lifecycle,
          result, failure_code as "failureCode", requested_at as "requestedAt", started_at as "startedAt",
          completed_at as "completedAt", created_at as "createdAt"
        from network_diagnostics
        where monitor_id = ${id} and requested_at >= ${since.toISOString()} ${regionCondition} ${cursorCondition}
        order by requested_at desc, id desc limit ${query.limit + 1}
      `,
    );
    const hasMore = diagnostics.length > query.limit;
    const page = diagnostics
      .slice(0, query.limit)
      .map((diagnostic) => serializeDnsDiagnostic(diagnostic, request.log));
    const last = page.at(-1);
    return {
      diagnostics: page,
      nextCursor:
        hasMore && last
          ? encodeDnsDiagnosticCursor({ requestedAt: last.requestedAt, id: last.id })
          : null,
    };
  });

  app.addHook('onClose', async () => {
    if (ownedDatabase) await database.close();
  });
  return app;
}

export async function startApi() {
  const app = await buildApi(process.env);
  const env = apiEnvSchema.parse(process.env);
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  return app;
}

function requireAdmin(
  request: FastifyRequest,
): asserts request is FastifyRequest & { admin: SessionAdmin } {
  if (!request.admin) throw httpError(401, 'unauthorized', 'Authentication is required');
}

function httpError(statusCode: number, code: string, message: string) {
  return Object.assign(new Error(message), { statusCode, code, isApiError: true });
}

function apiError(code: string, message: string, fieldErrors?: Record<string, string[]>) {
  return { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}

function hashSessionToken(token: string, secret: string) {
  return createHmac('sha256', secret).update(token).digest('base64url');
}

function sessionCookieOptions(env: ApiEnv, expires?: Date) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: env.SESSION_COOKIE_SECURE,
    ...(expires ? { expires } : {}),
  };
}

function nextBoundary(now: Date, intervalSeconds: number) {
  const interval = intervalSeconds * 1_000;
  return new Date((Math.floor(now.getTime() / interval) + 1) * interval);
}

async function rows<T extends object>(
  db: { execute: (query: Parameters<Database['execute']>[0]) => Promise<unknown> },
  query: Parameters<Database['execute']>[0],
): Promise<T[]> {
  const result = await db.execute(query);
  const value = result as { rows?: unknown } | unknown[];
  return (Array.isArray(value) ? value : (value.rows ?? [])) as T[];
}

interface MonitorRow {
  id: string;
  name: string | null;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  enabled: boolean;
  dnsDiagnosticsEnabled: boolean;
  isPublic: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}
interface DnsDiagnosticRow {
  id: string;
  monitorId: string;
  checkRunId: string | null;
  observationId: string | null;
  regionId: RegionId;
  kind: 'dns_candidates';
  windowStartedAt: Date | string;
  lifecycle: 'pending' | 'complete' | 'unavailable';
  result: unknown;
  failureCode: string | null;
  requestedAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
}
interface ObservationRow {
  id: string;
  checkRunId: string;
  monitorId: string;
  regionId: RegionId;
  status: 'success' | 'http_failure' | 'network_failure';
  success: boolean;
  httpStatus: number | null;
  responseMs: number | null;
  totalMs: number | null;
  errorCode: Observation['errorCode'];
  errorDetail: string | null;
  placement: string | null;
  colo: string | null;
  finalUrl: string | null;
  endpointEvidence: unknown;
  redirectCount: number | null;
  bodyBytes: number | null;
  probeVersion: string | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
}
interface LatencyRow {
  observedAt: Date | string;
  regionId: RegionId;
  responseMs: number | null;
  success: boolean;
}
interface PublicLatencyStatsRow {
  regionId: RegionId;
  sampleCount: number | string;
  successCount: number | string;
  p50Ms: number | string | null;
  p95Ms: number | string | null;
  p99Ms: number | string | null;
}

async function getMonitor(db: Database, id: string): Promise<MonitorRow | null> {
  const monitors = await rows<MonitorRow>(
    db,
    sql`select id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled, dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic", created_at as "createdAt", updated_at as "updatedAt" from monitors where id = ${id} limit 1`,
  );
  return monitors[0] ?? null;
}
async function getPublicMonitor(db: Database, id: string): Promise<MonitorRow | null> {
  const monitors = await rows<MonitorRow>(
    db,
    sql`select id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled, dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic", created_at as "createdAt", updated_at as "updatedAt" from monitors where id = ${id} and is_public = true limit 1`,
  );
  return monitors[0] ?? null;
}
async function getRegionIds(db: Database, monitorId: string): Promise<RegionId[]> {
  const selected = await rows<{ regionId: RegionId }>(
    db,
    sql`select region_id as "regionId" from monitor_regions where monitor_id = ${monitorId} order by region_id`,
  );
  return selected.map((row) => row.regionId);
}
async function monitorSummary(
  db: Database,
  row: MonitorRow,
  log: EndpointEvidenceLog,
): Promise<MonitorSummary> {
  const regionIds = await getRegionIds(db, row.id);
  const runs = await rows<{ id: string; windowStartedAt: Date | string }>(
    db,
    sql`select id, window_started_at as "windowStartedAt" from check_runs where monitor_id = ${row.id} and status in ('complete', 'partial') order by window_started_at desc limit 1`,
  );
  // An edit changes the monitor's execution contract. Do not present an old
  // region set or URL result as current evidence while waiting for the next run.
  const latestRun = runs[0];
  const latestRows =
    latestRun && new Date(latestRun.windowStartedAt).getTime() >= new Date(row.updatedAt).getTime()
      ? await rows<ObservationRow>(
          db,
          sql`select id, check_run_id as "checkRunId", monitor_id as "monitorId", region_id as "regionId", status, success, http_status as "httpStatus", response_ms as "responseMs", total_ms as "totalMs", error_code as "errorCode", error_detail as "errorDetail", placement, colo, final_url as "finalUrl", endpoint_evidence as "endpointEvidence", redirect_count as "redirectCount", body_bytes as "bodyBytes", probe_version as "probeVersion", started_at as "startedAt", completed_at as "completedAt" from observations where check_run_id = ${latestRun.id}`,
        )
      : [];
  const latestByRegion = Object.fromEntries(
    regionIds.map((id) => [id, null]),
  ) as MonitorSummary['latestByRegion'];
  for (const observation of latestRows)
    latestByRegion[observation.regionId] = serializeObservation(observation, log);
  const status = deriveAggregateStatus(regionIds, latestRows as LatestObservation[]);
  const monitor: Monitor = {
    id: row.id,
    name: row.name,
    url: row.url,
    regionIds,
    intervalSeconds: row.intervalSeconds as Monitor['intervalSeconds'],
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    dnsDiagnosticsEnabled: row.dnsDiagnosticsEnabled,
    isPublic: row.isPublic,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
  return {
    monitor,
    status,
    latestByRegion,
    targetChecksPerDay: calculateTargetChecksPerDay({
      regionIds,
      intervalSeconds: monitor.intervalSeconds,
    }).targetChecksPerDay,
  };
}
function toPublicMonitorSummary(summary: MonitorSummary): PublicMonitorSummary {
  const { dnsDiagnosticsEnabled: _dnsDiagnosticsEnabled, ...monitor } = summary.monitor;
  const latestByRegion = Object.fromEntries(
    Object.entries(summary.latestByRegion).map(([regionId, observation]) => [
      regionId,
      observation
        ? {
            regionId: observation.regionId,
            status: observation.status,
            success: observation.success,
            httpStatus: observation.httpStatus,
            responseMs: observation.responseMs,
            totalMs: observation.totalMs,
            errorCode: observation.errorCode,
            startedAt: observation.startedAt,
            completedAt: observation.completedAt,
          }
        : null,
    ]),
  ) as PublicMonitorSummary['latestByRegion'];
  return {
    monitor,
    status: summary.status,
    latestByRegion,
    targetChecksPerDay: summary.targetChecksPerDay,
  };
}
async function latencyPayload(
  db: Database,
  id: string,
  range: keyof typeof ranges,
  currentTime: () => Date,
) {
  const since = new Date(currentTime().getTime() - ranges[range]);
  const points = await rows<LatencyRow>(
    db,
    sql`
      select
        date_bin(${latencyBucketIntervals[range]}::interval, started_at, '1970-01-01T00:00:00.000Z'::timestamptz)
          as "observedAt",
        region_id as "regionId",
        avg(response_ms)::double precision as "responseMs",
        -- A bucket is successful only when every contributing observation succeeded.
        bool_and(success) as success
      from observations
      where monitor_id = ${id} and started_at >= ${since.toISOString()}
      group by 1, 2
      order by 1 asc, 2 asc
    `,
  );
  const exactStats = await rows<PublicLatencyStatsRow>(
    db,
    sql`
      select region_id as "regionId", count(*) as "sampleCount",
        count(*) filter (where success) as "successCount",
        percentile_disc(0.5) within group (order by response_ms)
          filter (where success and response_ms is not null) as "p50Ms",
        percentile_disc(0.95) within group (order by response_ms)
          filter (where success and response_ms is not null) as "p95Ms",
        percentile_disc(0.99) within group (order by response_ms)
          filter (where success and response_ms is not null) as "p99Ms"
      from observations
      where monitor_id = ${id} and started_at >= ${since.toISOString()}
      group by region_id
    `,
  );
  const configuredRegionIds = await getRegionIds(db, id);
  const statsByRegion = new Map(exactStats.map((stat) => [stat.regionId, stat]));
  const historicalRegionIds = new Set(exactStats.map((stat) => stat.regionId));
  const regionIds = regions
    .map((region) => region.id)
    .filter(
      (regionId) => configuredRegionIds.includes(regionId) || historicalRegionIds.has(regionId),
    );
  const stats = regionIds.map((regionId) => {
    const stat = statsByRegion.get(regionId);
    return {
      regionId,
      sampleCount: Number(stat?.sampleCount ?? 0),
      successCount: Number(stat?.successCount ?? 0),
      p50Ms: stat?.p50Ms === null || stat?.p50Ms === undefined ? null : Number(stat.p50Ms),
      p95Ms: stat?.p95Ms === null || stat?.p95Ms === undefined ? null : Number(stat.p95Ms),
      p99Ms: stat?.p99Ms === null || stat?.p99Ms === undefined ? null : Number(stat.p99Ms),
    };
  });
  return { range, points: points.map(serializeLatencyPoint), stats };
}
function serializeObservation(row: ObservationRow, log: EndpointEvidenceLog): Observation {
  return {
    ...row,
    endpointEvidence: parseStoredEndpointEvidence(row.endpointEvidence, row.id, row.finalUrl, log),
    dnsDiagnostic: null,
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : null,
  };
}
function serializeLatencyPoint(row: LatencyRow) {
  return {
    ...row,
    observedAt: iso(row.observedAt),
    responseMs: row.responseMs === null ? null : Number(row.responseMs),
  };
}
function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
export function encodeCursor(value: z.infer<typeof cursorSchema>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function decodeCursor(value: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw httpError(400, 'invalid_cursor', 'Cursor is invalid');
  }
}
export function encodeDnsDiagnosticCursor(value: z.infer<typeof dnsDiagnosticCursorSchema>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function decodeDnsDiagnosticCursor(value: string) {
  try {
    return dnsDiagnosticCursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw httpError(400, 'invalid_cursor', 'Cursor is invalid');
  }
}
function serializeDnsDiagnostic(row: DnsDiagnosticRow, log: DnsDiagnosticLog) {
  const result = parseStoredDnsDiagnostic(row.result, row.id, log);
  const lifecycle = row.lifecycle === 'complete' && result === null ? 'unavailable' : row.lifecycle;
  return {
    id: row.id,
    monitorId: row.monitorId,
    checkRunId: row.checkRunId,
    observationId: row.observationId,
    regionId: row.regionId,
    kind: row.kind,
    windowStartedAt: iso(row.windowStartedAt),
    lifecycle,
    finalHostname: result?.finalHostname ?? null,
    result,
    failureCode:
      lifecycle === 'unavailable' && row.lifecycle === 'complete' && result === null
        ? 'protocol_invalid_response'
        : row.failureCode,
    requestedAt: iso(row.requestedAt),
    startedAt: row.startedAt ? iso(row.startedAt) : null,
    completedAt: row.completedAt ? iso(row.completedAt) : null,
    createdAt: iso(row.createdAt),
  };
}
