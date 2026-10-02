import { createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { apiEnvSchema, regionById, regions, type ApiEnv } from '@uptime/config';
import {
  calculateTargetChecksPerDay,
  discordConfigSchema,
  estimateRequestSchema,
  monitorBulkFrequencyUpdateSchema,
  monitorCreateSchema,
  monitorUpdateSchema,
  gotifyConfigSchema,
  homeAssistantConfigSchema,
  notificationServiceCreateSchema,
  notificationServiceUpdateSchema,
  resendConfigSchema,
  regionIdSchema,
  statusPageSaveSchema,
  smtpConfigSchema,
  telegramConfigSchema,
  webhookConfigSchema,
  type StatusPageSave,
  type Monitor,
  type MonitorSummary,
  type NotificationService,
  type NotificationProviderKind,
  type Observation,
  type PublicMonitorSummary,
  type RegionId,
} from '@uptime/contracts';
import { createDatabase, type Database } from '@uptime/database';
import { createNotificationProvider } from '@uptime/notifications';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { assertResolvablePublicHttpUrl, UrlPolicyError } from './security.js';
import { deriveAggregateStatus, type LatestObservation } from './status.js';
import { assertValidAdminPasswordHash, verifyAdminPassword } from './auth.js';
import { parseStoredEndpointEvidence, type EndpointEvidenceLog } from './endpoint-evidence.js';
import { parseStoredDnsDiagnostic, type DnsDiagnosticLog } from './dns-diagnostics.js';

type SupportedNotificationProviderKind = Exclude<NotificationProviderKind, 'bluesky'>;

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
export const aggregateLatencyBucketIntervals = {
  '1h': '1 minute',
  '24h': '5 minutes',
  '7d': '15 minutes',
  '30d': '1 hour',
} as const;
const rangeSchema = z.enum(['1h', '24h', '7d', '30d']).default('24h');
const diagnosticRangeSchema = z.enum(['7d', '30d']).default('7d');
// Set the exact number of trusted proxies so rate limits use the correct client address.
const publicMonitorRateLimit = { max: 30, timeWindow: '1 minute' };
const idSchema = z.object({ id: z.uuid() });
const publicMonitorReferenceSchema = z.object({
  id: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9.-]+$/),
});
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
  notificationFetch?: typeof fetch;
}

export async function buildApi(
  source: Record<string, unknown>,
  dependencies: ApiDependencies = {},
) {
  const env = apiEnvSchema.parse(source) as ApiEnv;
  const enabledRegionIds = new Set(env.REGIONS_LIST);
  const enabledRegions = env.REGIONS_LIST.map((regionId) => regionById[regionId]);
  const assertRegionsEnabled = (regionIds: readonly RegionId[]) => {
    const disabled = regionIds.filter((regionId) => !enabledRegionIds.has(regionId));
    if (disabled.length > 0) {
      throw httpError(
        400,
        'region_disabled',
        `These regions are not enabled by REGIONS_LIST: ${disabled.join(', ')}`,
      );
    }
  };
  await assertValidAdminPasswordHash(env.ADMIN_PASSWORD_HASH);
  const ownedDatabase = dependencies.db === undefined;
  const database = dependencies.db
    ? { db: dependencies.db, close: async () => undefined }
    : createDatabase(env.DATABASE_URL);
  const now = dependencies.now ?? (() => new Date());
  // Fastify 5.12 requires the function form for a numeric proxy-hop limit.
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
        where sessions.token_hash = ${hash} and sessions.expires_at > ${now().toISOString()}
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
    if (_request.url.startsWith('/api/notification-services')) {
      // Database errors can carry SQL parameters containing provider credentials.
      app.log.error({ event: 'notification_request_failed' }, 'Notification request failed');
    } else {
      app.log.error(error);
    }
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

  app.get('/api/regions', async () => ({ regions: enabledRegions }));
  app.post('/api/estimates', async (request) =>
    calculateTargetChecksPerDay(estimateRequestSchema.parse(request.body)),
  );

  app.get('/api/notification-services', async (request) => {
    requireAdmin(request);
    const services = await rows<NotificationServiceRow>(
      database.db,
      sql`select id, name, provider, enabled, config, created_at as "createdAt", updated_at as "updatedAt" from notification_services order by created_at desc`,
    );
    return { services: services.map(serializeNotificationService) };
  });

  app.post('/api/notification-services', async (request, reply) => {
    requireAdmin(request);
    const input = notificationServiceCreateSchema.parse(request.body);
    assertSupportedProvider(input.provider);
    const inserted = await rows<NotificationServiceRow>(
      database.db,
      sql`
        insert into notification_services (name, provider, enabled, config)
        values (${input.name}, ${input.provider}, ${input.enabled}, ${JSON.stringify(input.config)}::jsonb)
        returning id, name, provider, enabled, config, created_at as "createdAt", updated_at as "updatedAt"
      `,
    );
    const service = inserted[0];
    if (!service) throw new Error('Notification service insert did not return a row');
    return reply.code(201).send({ service: serializeNotificationService(service) });
  });

  app.patch('/api/notification-services/:id', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const input = notificationServiceUpdateSchema.parse(request.body);
    const service = await database.db.transaction(async (tx) => {
      const current = await getNotificationServiceForUpdate(tx, id);
      if (!current) throw httpError(404, 'not_found', 'Notification service was not found');
      assertSupportedProvider(current.provider);
      const config = mergeNotificationConfig(current.provider, current.config, input.config);
      const configurationChanged = !isDeepStrictEqual(config, current.config);
      const enabledChanged = current.enabled !== (input.enabled ?? current.enabled);
      const updated = await rows<NotificationServiceRow>(
        tx,
        sql`
          update notification_services
          set name = ${input.name ?? current.name}, enabled = ${input.enabled ?? current.enabled},
            config = ${JSON.stringify(config)}::jsonb, updated_at = now()
          where id = ${id}
          returning id, name, provider, enabled, config, created_at as "createdAt", updated_at as "updatedAt"
        `,
      );
      if (enabledChanged || configurationChanged) {
        await cancelAllPendingNotificationDeliveries(tx, id);
        await invalidateNotificationStateForService(tx, id);
      }
      return updated[0];
    });
    if (!service) throw httpError(404, 'not_found', 'Notification service was not found');
    return { service: serializeNotificationService(service) };
  });

  app.delete('/api/notification-services/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const deleted = await rows<{ id: string }>(
      database.db,
      sql`delete from notification_services where id = ${id} returning id`,
    );
    if (!deleted[0]) throw httpError(404, 'not_found', 'Notification service was not found');
    return reply.code(204).send();
  });

  app.post(
    '/api/notification-services/:id/test',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      requireAdmin(request);
      const { id } = idSchema.parse(request.params);
      const service = await getNotificationService(database.db, id);
      if (!service) throw httpError(404, 'not_found', 'Notification service was not found');
      try {
        const provider = dependencies.notificationFetch
          ? createNotificationProvider(
              service.provider,
              service.config,
              dependencies.notificationFetch,
            )
          : createNotificationProvider(service.provider, service.config);
        await provider.send({
          kind: 'test',
          monitorName: 'Uptime notification test',
          monitorUrl: 'https://example.com',
          occurredAt: now().toISOString(),
          outageStartedAt: null,
        });
      } catch (error) {
        request.log.warn(
          {
            notificationServiceId: id,
            provider: service.provider,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          'Notification service test failed',
        );
        throw httpError(
          502,
          'notification_failed',
          'The notification service could not send a test',
        );
      }
      return { success: true };
    },
  );

  app.get('/api/monitors', async (request) => {
    requireAdmin(request);
    const monitorRows = await rows<MonitorRow>(
      database.db,
      sql`
      select id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled,
        dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic", public_slug as "publicSlug",
        outage_threshold as "outageThreshold", recovery_threshold as "recoveryThreshold",
        repeat_notification_minutes as "repeatNotificationMinutes",
        coalesce(array(select notification_service_id from monitor_notification_services where monitor_id = monitors.id order by notification_service_id), array[]::uuid[]) as "notificationServiceIds",
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
    const notificationServiceIds = input.notificationServiceIds ?? [];
    assertRegionsEnabled(input.regionIds);
    await assertResolvablePublicHttpUrl(input.url);
    await assertPublicSlugAvailable(database.db, input.publicSlug ?? null);
    const created = await database.db.transaction(async (tx) => {
      await assertNotificationServicesExist(tx, notificationServiceIds);
      const nextCheckAt = nextBoundary(now(), input.intervalSeconds);
      const inserted = await rows<MonitorRow>(
        tx,
        sql`
        insert into monitors (name, url, interval_seconds, timeout_ms, enabled, dns_diagnostics_enabled, is_public, public_slug, outage_threshold, recovery_threshold, repeat_notification_minutes, next_check_at)
        values (${input.name ?? null}, ${input.url}, ${input.intervalSeconds}, ${input.timeoutMs}, ${input.enabled}, ${input.dnsDiagnosticsEnabled}, ${input.isPublic}, ${input.publicSlug ?? null}, ${input.outageThreshold ?? 3}, ${input.recoveryThreshold ?? 2}, ${input.repeatNotificationMinutes ?? null}, ${nextCheckAt.toISOString()})
        returning id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled,
          dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic", public_slug as "publicSlug",
          outage_threshold as "outageThreshold", recovery_threshold as "recoveryThreshold",
          repeat_notification_minutes as "repeatNotificationMinutes",
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
      await replaceMonitorNotificationServices(tx, monitor.id, notificationServiceIds);
      return { ...monitor, notificationServiceIds };
    });
    return reply
      .code(201)
      .send({ summary: await monitorSummary(database.db, created, request.log) });
  });

  app.patch('/api/monitors/bulk-frequency', async (request) => {
    requireAdmin(request);
    const input = monitorBulkFrequencyUpdateSchema.parse(request.body);
    const uniqueMonitorIds = [...new Set(input.monitorIds)];
    const nextCheckAt = nextBoundary(now(), input.intervalSeconds);
    const updatedCount = await database.db.transaction(async (tx) => {
      const updated = await rows<{ id: string }>(
        tx,
        sql`
          update monitors
          set interval_seconds = ${input.intervalSeconds},
            next_check_at = ${nextCheckAt.toISOString()},
            updated_at = now()
          where id in (${sql.join(
            uniqueMonitorIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          returning id
        `,
      );
      if (updated.length !== uniqueMonitorIds.length) {
        throw httpError(404, 'not_found', 'One or more monitors were not found');
      }
      return updated.length;
    });
    return { updatedCount };
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
      const { id } = publicMonitorReferenceSchema.parse(request.params);
      const monitor = await getPublicMonitor(database.db, id);
      if (!monitor) throw httpError(404, 'not_found', 'Monitor was not found');
      return {
        summary: toPublicMonitorSummary(await monitorSummary(database.db, monitor, request.log)),
      };
    },
  );

  app.get('/api/monitors/:id/uptime', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    if (!(await getMonitor(database.db, id))) {
      throw httpError(404, 'not_found', 'Monitor was not found');
    }
    return { uptime: await monitorUptimePayload(database.db, id, now) };
  });

  app.get(
    '/api/monitors/public/:id/uptime',
    { config: { rateLimit: publicMonitorRateLimit } },
    async (request) => {
      const { id } = publicMonitorReferenceSchema.parse(request.params);
      const monitor = await getPublicMonitor(database.db, id);
      if (!monitor) {
        throw httpError(404, 'not_found', 'Monitor was not found');
      }
      return { uptime: await monitorUptimePayload(database.db, monitor.id, now) };
    },
  );

  app.patch('/api/monitors/:id', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const current = await getMonitor(database.db, id);
    if (!current) throw httpError(404, 'not_found', 'Monitor was not found');
    const update = monitorUpdateSchema.parse(request.body);
    const currentRegionIds = await getRegionIds(database.db, id);
    const currentNotificationServiceIds = current.notificationServiceIds ?? [];
    const merged = monitorCreateSchema.parse({
      name: current.name ?? undefined,
      url: current.url,
      regionIds: currentRegionIds,
      intervalSeconds: current.intervalSeconds,
      timeoutMs: current.timeoutMs,
      enabled: current.enabled,
      dnsDiagnosticsEnabled: current.dnsDiagnosticsEnabled,
      isPublic: current.isPublic,
      publicSlug: current.publicSlug,
      notificationServiceIds: currentNotificationServiceIds,
      outageThreshold: current.outageThreshold,
      recoveryThreshold: current.recoveryThreshold,
      repeatNotificationMinutes: current.repeatNotificationMinutes,
      ...update,
    });
    const mergedNotificationServiceIds = merged.notificationServiceIds ?? [];
    const notificationMembershipChanged = !sameStringSet(
      mergedNotificationServiceIds,
      currentNotificationServiceIds,
    );
    const notificationRulesChanged =
      merged.url !== current.url ||
      merged.enabled !== current.enabled ||
      (merged.outageThreshold ?? 3) !== current.outageThreshold ||
      (merged.recoveryThreshold ?? 2) !== current.recoveryThreshold ||
      (merged.repeatNotificationMinutes ?? null) !== current.repeatNotificationMinutes ||
      !sameStringSet(merged.regionIds, currentRegionIds);
    assertRegionsEnabled(merged.regionIds);
    await assertResolvablePublicHttpUrl(merged.url);
    await assertPublicSlugAvailable(database.db, merged.publicSlug ?? null, id);
    const updated = await database.db.transaction(async (tx) => {
      await assertNotificationServicesExist(tx, mergedNotificationServiceIds);
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
          public_slug = ${merged.publicSlug ?? null},
          outage_threshold = ${merged.outageThreshold ?? 3},
          recovery_threshold = ${merged.recoveryThreshold ?? 2},
          repeat_notification_minutes = ${merged.repeatNotificationMinutes ?? null},
          next_check_at = coalesce(${nextCheckAt?.toISOString() ?? null}, next_check_at), updated_at = now()
        where id = ${id}
        returning id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled,
          dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic", public_slug as "publicSlug",
          outage_threshold as "outageThreshold", recovery_threshold as "recoveryThreshold",
          repeat_notification_minutes as "repeatNotificationMinutes",
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
      if (update.notificationServiceIds) {
        await replaceMonitorNotificationServices(tx, id, mergedNotificationServiceIds);
      }
      if (notificationRulesChanged || notificationMembershipChanged) {
        await cancelAllMonitorNotificationDeliveries(tx, id);
        await invalidateMonitorNotificationState(tx, id);
      }
      const row = changed[0];
      if (!row) throw httpError(404, 'not_found', 'Monitor was not found');
      return { ...row, notificationServiceIds: mergedNotificationServiceIds };
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

  app.get('/api/status-pages', async (request) => {
    requireAdmin(request);
    const pages = await rows<StatusPageRow>(
      database.db,
      sql`
        select sp.id, sp.title, sp.public_slug as "publicSlug", sp.created_at as "createdAt", sp.updated_at as "updatedAt",
          count(spm.monitor_id)::integer as "monitorCount"
        from status_pages sp
        left join status_page_monitors spm on spm.status_page_id = sp.id
        group by sp.id
        order by sp.created_at desc
      `,
    );
    return { statusPages: pages.map(serializeStatusPageSummary) };
  });

  app.post('/api/status-pages', async (request, reply) => {
    requireAdmin(request);
    const input = statusPageSaveSchema.parse(request.body);
    await assertStatusPageSlugAvailable(database.db, input.publicSlug ?? null);
    const created = await database.db.transaction(async (tx) => {
      await assertStatusPageMonitorsExist(tx, input);
      const inserted = await rows<StatusPageRow>(
        tx,
        sql`insert into status_pages (title, public_slug) values (${input.title}, ${input.publicSlug ?? null}) returning id, title, public_slug as "publicSlug", created_at as "createdAt", updated_at as "updatedAt"`,
      );
      const page = inserted[0];
      if (!page) throw new Error('Status page insert did not return a row');
      await replaceStatusPageGroups(tx, page.id, input);
      return page;
    });
    return reply.code(201).send({ statusPage: await getStatusPage(database.db, created.id) });
  });

  app.get('/api/status-pages/:id', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const statusPage = await getStatusPage(database.db, id);
    if (!statusPage) throw httpError(404, 'not_found', 'Status page was not found');
    return { statusPage };
  });

  app.put('/api/status-pages/:id', async (request) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const input = statusPageSaveSchema.parse(request.body);
    await assertStatusPageSlugAvailable(database.db, input.publicSlug ?? null, id);
    await database.db.transaction(async (tx) => {
      await assertStatusPageMonitorsExist(tx, input);
      const updated = await rows<{ id: string }>(
        tx,
        sql`update status_pages set title = ${input.title}, public_slug = ${input.publicSlug ?? null}, updated_at = now() where id = ${id} returning id`,
      );
      if (!updated[0]) throw httpError(404, 'not_found', 'Status page was not found');
      await replaceStatusPageGroups(tx, id, input);
    });
    return { statusPage: await getStatusPage(database.db, id) };
  });

  app.delete('/api/status-pages/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = idSchema.parse(request.params);
    const deleted = await rows<{ id: string }>(
      database.db,
      sql`delete from status_pages where id = ${id} returning id`,
    );
    if (!deleted[0]) throw httpError(404, 'not_found', 'Status page was not found');
    return reply.code(204).send();
  });

  app.get(
    '/api/status-pages/public/:id',
    { config: { rateLimit: publicMonitorRateLimit } },
    async (request) => {
      const { id } = publicMonitorReferenceSchema.parse(request.params);
      const statusPage = await getPublicStatusPage(database.db, id);
      if (!statusPage) throw httpError(404, 'not_found', 'Status page was not found');
      return publicStatusPagePayload(database.db, statusPage, now);
    },
  );

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
      const { id } = publicMonitorReferenceSchema.parse(request.params);
      const { range } = z.object({ range: rangeSchema }).parse(request.query);
      const monitor = await getPublicMonitor(database.db, id);
      if (!monitor) {
        throw httpError(404, 'not_found', 'Monitor was not found');
      }
      return latencyPayload(database.db, monitor.id, range, now);
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

interface SqlExecutor {
  execute(query: Parameters<Database['execute']>[0]): Promise<unknown>;
}

async function rows<T extends object>(
  db: SqlExecutor,
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
  publicSlug: string | null;
  outageThreshold: number;
  recoveryThreshold: number;
  repeatNotificationMinutes: number | null;
  notificationServiceIds?: string[];
  createdAt: Date | string;
  updatedAt: Date | string;
}
interface NotificationServiceRow {
  id: string;
  name: string;
  provider: NotificationProviderKind;
  enabled: boolean;
  config: Record<string, unknown>;
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
interface AggregateLatencyRow {
  observedAt: Date | string;
  responseMs: number | string | null;
  success: boolean;
}
interface AggregateLatencyStatsRow {
  averageResponseMs: number | string | null;
  maximumResponseMs: number | string | null;
  maximumResponseRegionId: RegionId | null;
  minimumResponseMs: number | string | null;
}
interface PublicLatencyStatsRow {
  regionId: RegionId;
  sampleCount: number | string;
  successCount: number | string;
  p50Ms: number | string | null;
  p95Ms: number | string | null;
  p99Ms: number | string | null;
}

interface StatusPageRow {
  id: string;
  title: string;
  publicSlug: string | null;
  monitorCount?: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
}
interface StatusPageGroupRow {
  id: string;
  title: string;
  position: number;
}
interface StatusPageMonitorRow {
  groupId: string;
  id: string;
  name: string | null;
  url: string;
  publicSlug: string | null;
  position: number;
}
interface StatusPageDailyRow {
  monitorId: string;
  day: Date | string;
  uptimePercentage?: number | string | null;
  weight?: number | string | null;
  receivedCount?: number | string | null;
  successCount?: number | string | null;
  averageResponseMs: number | string | null;
}
interface MonitorUptimeDay {
  date: string;
  uptimePercentage: number | null;
  averageResponseMs: number | null;
}
interface MonitorUptimePayload {
  uptimePercentage: number | null;
  status: 'up' | 'down' | 'unknown';
  recoveryStatus?: 'up' | 'down' | 'recovering' | null;
  days: MonitorUptimeDay[];
}

function serializeStatusPageSummary(row: StatusPageRow) {
  return {
    id: row.id,
    title: row.title,
    publicSlug: row.publicSlug,
    monitorCount: Number(row.monitorCount ?? 0),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function getStatusPage(db: SqlExecutor, id: string) {
  const page = (
    await rows<StatusPageRow>(
      db,
      sql`select id, title, public_slug as "publicSlug", created_at as "createdAt", updated_at as "updatedAt" from status_pages where id = ${id} limit 1`,
    )
  )[0];
  if (!page) return null;
  const groups = await rows<StatusPageGroupRow>(
    db,
    sql`select id, title, position from status_page_groups where status_page_id = ${id} order by position`,
  );
  const monitors = await rows<StatusPageMonitorRow>(
    db,
    sql`
      select spm.group_id as "groupId", m.id, m.name, m.url, m.public_slug as "publicSlug", spm.position
      from status_page_monitors spm
      join monitors m on m.id = spm.monitor_id
      where spm.status_page_id = ${id}
      order by spm.position
    `,
  );
  return {
    ...serializeStatusPageSummary({ ...page, monitorCount: monitors.length }),
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
      position: group.position,
      monitors: monitors
        .filter((monitor) => monitor.groupId === group.id)
        .map((monitor) => ({
          id: monitor.id,
          name: monitor.name,
          url: monitor.url,
          publicSlug: monitor.publicSlug,
          position: monitor.position,
        })),
    })),
  };
}

async function getPublicStatusPage(db: SqlExecutor, reference: string) {
  if (z.uuid().safeParse(reference).success) return getStatusPage(db, reference);
  const matched = await rows<{ id: string }>(
    db,
    sql`select id from status_pages where public_slug = ${reference} limit 1`,
  );
  return matched[0] ? getStatusPage(db, matched[0].id) : null;
}

async function assertStatusPageSlugAvailable(
  db: SqlExecutor,
  publicSlug: string | null,
  excludedStatusPageId?: string,
) {
  if (!publicSlug) return;
  const conflicts = await rows<{ id: string }>(
    db,
    sql`select id from status_pages where public_slug = ${publicSlug} and (${excludedStatusPageId ?? null}::uuid is null or id <> ${excludedStatusPageId ?? null}::uuid) limit 1`,
  );
  if (conflicts[0]) {
    throw httpError(409, 'slug_conflict', 'That public status page slug is already in use');
  }
}

async function assertStatusPageMonitorsExist(db: SqlExecutor, input: StatusPageSave) {
  const monitorIds = input.groups.flatMap((group) => group.monitorIds);
  for (const monitorId of monitorIds) {
    const found = await rows<{ id: string }>(
      db,
      sql`select id from monitors where id = ${monitorId} limit 1`,
    );
    if (!found[0]) throw httpError(400, 'invalid_monitor', `Monitor ${monitorId} was not found`);
  }
}

async function replaceStatusPageGroups(
  db: SqlExecutor,
  statusPageId: string,
  input: StatusPageSave,
) {
  await db.execute(sql`delete from status_page_groups where status_page_id = ${statusPageId}`);
  for (const [groupPosition, group] of input.groups.entries()) {
    const inserted = await rows<{ id: string }>(
      db,
      sql`insert into status_page_groups (status_page_id, title, position) values (${statusPageId}, ${group.title}, ${groupPosition}) returning id`,
    );
    const groupId = inserted[0]?.id;
    if (!groupId) throw new Error('Status page group insert did not return a row');
    for (const [monitorPosition, monitorId] of group.monitorIds.entries()) {
      await db.execute(sql`
        insert into status_page_monitors (status_page_id, group_id, monitor_id, position)
        values (${statusPageId}, ${groupId}, ${monitorId}, ${monitorPosition})
      `);
    }
  }
}

function uptimeWindow(currentTime: () => Date) {
  const today = new Date(currentTime());
  today.setUTCHours(0, 0, 0, 0);
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - 89);
  const dayKeys = Array.from({ length: 90 }, (_, index) => {
    const day = new Date(since);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
  return { today, since, dayKeys };
}

function summarizeMonitorUptime(
  monitorDays: ReadonlyMap<string, StatusPageDailyRow>,
  dayKeys: readonly string[],
): MonitorUptimePayload {
  let totalWeight = 0;
  let weightedUptime = 0;
  const days = dayKeys.map((date) => {
    const row = monitorDays.get(date);
    const receivedCount = Number(row?.receivedCount ?? 0);
    const successCount = Number(row?.successCount ?? 0);
    const explicitPercentage =
      row?.uptimePercentage === null || row?.uptimePercentage === undefined
        ? null
        : Number(row.uptimePercentage);
    const uptimePercentage =
      explicitPercentage ?? (receivedCount === 0 ? null : (successCount / receivedCount) * 100);
    const explicitWeight = Number(row?.weight ?? 0);
    const weight = explicitWeight > 0 ? explicitWeight : receivedCount > 0 ? receivedCount : 1;
    if (uptimePercentage !== null) {
      totalWeight += weight;
      weightedUptime += uptimePercentage * weight;
    }
    return {
      date,
      // Scheduler-to-Worker transport failures contain no target uptime result.
      uptimePercentage,
      averageResponseMs:
        row?.averageResponseMs === null || row?.averageResponseMs === undefined
          ? null
          : Number(row.averageResponseMs),
    };
  });
  const measured = days.filter((day) => day.uptimePercentage !== null);
  return {
    uptimePercentage: totalWeight === 0 ? null : weightedUptime / totalWeight,
    status:
      measured.length === 0
        ? 'unknown'
        : (measured.at(-1)?.uptimePercentage ?? 0) === 100
          ? 'up'
          : 'down',
    days,
  };
}

async function monitorUptimePayload(
  db: Database,
  monitorId: string,
  currentTime: () => Date,
): Promise<MonitorUptimePayload> {
  const { today, since, dayKeys } = uptimeWindow(currentTime);
  const daily = await rows<StatusPageDailyRow>(
    db,
    sql`
      with stored as (
        select monitor_id, day, uptime_percentage, average_response_ms, weight,
          received_count, success_count
        from monitor_daily_uptime
        where monitor_id = ${monitorId}
          and day >= ${since.toISOString()}::date
          and day < ${today.toISOString()}::date
      ), eligible_runs as (
        select cr.id, cr.monitor_id, (cr.window_started_at at time zone 'UTC')::date as day
        from check_runs cr
        where cr.monitor_id = ${monitorId}
          and cr.window_started_at >= ${since.toISOString()}
          and cr.status in ('complete', 'partial')
          and (
            cr.window_started_at >= ${today.toISOString()}
            or not exists (
              select 1 from monitor_daily_uptime mdu
              where mdu.monitor_id = cr.monitor_id
                and mdu.day = (cr.window_started_at at time zone 'UTC')::date
            )
          )
      ), observed as (
        select er.monitor_id, er.day,
          count(*)::integer as received_count,
          count(*) filter (where o.success)::integer as success_count,
          avg(o.response_ms) filter (where o.success and o.response_ms is not null)::double precision as average_response_ms
        from eligible_runs er
        join observations o on o.check_run_id = er.id
        group by er.monitor_id, er.day
      )
      select monitor_id as "monitorId", day,
        uptime_percentage as "uptimePercentage", weight,
        received_count as "receivedCount", success_count as "successCount",
        average_response_ms as "averageResponseMs"
      from stored
      union all
      select monitor_id as "monitorId", day,
        (success_count::double precision / received_count) * 100 as "uptimePercentage",
        received_count::double precision as weight,
        received_count as "receivedCount", success_count as "successCount",
        average_response_ms as "averageResponseMs"
      from observed
      where received_count > 0
      order by day
    `,
  );
  const monitorDays = new Map<string, StatusPageDailyRow>();
  for (const row of daily) {
    const key =
      typeof row.day === 'string' ? row.day.slice(0, 10) : row.day.toISOString().slice(0, 10);
    monitorDays.set(key, row);
  }
  const recovery = await rows<{
    recoveryStatus: 'up' | 'down' | 'recovering' | null;
  }>(
    db,
    sql`
      with ranked as (
        select o.region_id, cr.window_started_at, o.success,
          row_number() over (
            partition by o.region_id
            order by cr.window_started_at desc, o.completed_at desc
          ) as recency
        from check_runs cr
        join observations o on o.check_run_id = cr.id
        where cr.monitor_id = ${monitorId}
          and cr.status in ('complete', 'partial')
      ), issue_regions as (
        select distinct o.region_id
        from check_runs cr
        join observations o on o.check_run_id = cr.id
        where cr.monitor_id = ${monitorId}
          and cr.status in ('complete', 'partial')
          and cr.window_started_at >= ${today.toISOString()}
          and o.success = false
      ), states as (
        select issues.region_id,
          case
            when count(*) filter (where ranked.recency <= 5) = 5
              and bool_and(ranked.success) filter (where ranked.recency <= 5) then 'up'
            when count(*) filter (where ranked.recency <= 2) = 2
              and bool_and(ranked.success) filter (where ranked.recency <= 2) then 'recovering'
            else 'down'
          end as state
        from issue_regions issues
        join ranked on ranked.region_id = issues.region_id
        group by issues.region_id
      )
      select case
        when bool_or(state = 'down') then 'down'
        when bool_or(state = 'recovering') then 'recovering'
        when bool_or(state = 'up') then 'up'
        else null
      end as "recoveryStatus"
      from states
    `,
  );
  return {
    ...summarizeMonitorUptime(monitorDays, dayKeys),
    recoveryStatus: recovery[0]?.recoveryStatus ?? null,
  };
}

async function publicStatusPagePayload(
  db: Database,
  statusPage: NonNullable<Awaited<ReturnType<typeof getStatusPage>>>,
  currentTime: () => Date,
) {
  const { today, since, dayKeys } = uptimeWindow(currentTime);
  const daily = await rows<StatusPageDailyRow>(
    db,
    sql`
      with page_monitors as (
        select monitor_id from status_page_monitors where status_page_id = ${statusPage.id}
      ), stored as (
        select mdu.monitor_id, mdu.day, mdu.uptime_percentage, mdu.average_response_ms,
          mdu.weight, mdu.received_count, mdu.success_count
        from monitor_daily_uptime mdu
        join page_monitors pm on pm.monitor_id = mdu.monitor_id
        where mdu.day >= ${since.toISOString()}::date
          and mdu.day < ${today.toISOString()}::date
      ), missing_days as (
        -- Closed days without a finalized rollup are rare; enumerate them from
        -- the small stored set instead of scanning 90 days of check runs.
        select pm.monitor_id, d.day
        from page_monitors pm
        cross join (
          select generate_series(${since.toISOString()}::date, (${today.toISOString()}::date - 1), '1 day'::interval)::date as day
        ) d
        left join stored s on s.monitor_id = pm.monitor_id and s.day = d.day
        where s.monitor_id is null
      ), today_observed as (
        -- Today's partial day is the only large unrolled slice. Aggregate it
        -- per monitor so each probe uses the (monitor_id, window_started_at)
        -- index instead of sequential-scanning the wide observations table.
        select pm.monitor_id, ${today.toISOString()}::date as day,
          t.received_count, t.success_count, t.average_response_ms
        from page_monitors pm
        cross join lateral (
          select count(*)::integer as received_count,
            count(*) filter (where o.success)::integer as success_count,
            avg(o.response_ms) filter (where o.success and o.response_ms is not null)::double precision as average_response_ms
          from check_runs cr
          join observations o on o.check_run_id = cr.id
          where cr.monitor_id = pm.monitor_id
            and cr.window_started_at >= ${today.toISOString()}
            and cr.status in ('complete', 'partial')
        ) t
        where t.received_count > 0
      ), missing_observed as (
        select md.monitor_id, md.day,
          t.received_count, t.success_count, t.average_response_ms
        from missing_days md
        cross join lateral (
          select count(*)::integer as received_count,
            count(*) filter (where o.success)::integer as success_count,
            avg(o.response_ms) filter (where o.success and o.response_ms is not null)::double precision as average_response_ms
          from check_runs cr
          join observations o on o.check_run_id = cr.id
          where cr.monitor_id = md.monitor_id
            and cr.window_started_at >= timezone('UTC', md.day::timestamp)
            and cr.window_started_at < timezone('UTC', (md.day + 1)::timestamp)
            and cr.status in ('complete', 'partial')
        ) t
        where t.received_count > 0
      )
      select monitor_id as "monitorId", day,
        uptime_percentage as "uptimePercentage", weight,
        received_count as "receivedCount", success_count as "successCount",
        average_response_ms as "averageResponseMs"
      from stored
      union all
      select monitor_id as "monitorId", day,
        (success_count::double precision / received_count) * 100 as "uptimePercentage",
        received_count::double precision as weight,
        received_count as "receivedCount", success_count as "successCount",
        average_response_ms as "averageResponseMs"
      from today_observed
      union all
      select monitor_id as "monitorId", day,
        (success_count::double precision / received_count) * 100 as "uptimePercentage",
        received_count::double precision as weight,
        received_count as "receivedCount", success_count as "successCount",
        average_response_ms as "averageResponseMs"
      from missing_observed
      order by "monitorId", day
    `,
  );
  const byMonitor = new Map<string, Map<string, StatusPageDailyRow>>();
  for (const row of daily) {
    const key =
      typeof row.day === 'string' ? row.day.slice(0, 10) : row.day.toISOString().slice(0, 10);
    const monitorDays = byMonitor.get(row.monitorId) ?? new Map<string, StatusPageDailyRow>();
    monitorDays.set(key, row);
    byMonitor.set(row.monitorId, monitorDays);
  }
  const currentRegions = await rows<{
    monitorId: string;
    configuredRegionCount: number | string;
    affectedRegionIds: RegionId[] | null;
    recoveryStatus: 'up' | 'down' | 'recovering' | null;
  }>(
    db,
    sql`
      with page_monitors as (
        select distinct monitor_id
        from status_page_monitors
        where status_page_id = ${statusPage.id}
      ), today_failures as (
        -- Only regions failing today need recovery inspection. The old
        -- ranking windowed all 90 days of observations (~2M rows) to read
        -- the latest five per region; probe just the failing pairs instead.
        select distinct cr.monitor_id, o.region_id
        from check_runs cr
        join page_monitors pm on pm.monitor_id = cr.monitor_id
        join observations o on o.check_run_id = cr.id
        where cr.status in ('complete', 'partial')
          and cr.window_started_at >= ${today.toISOString()}
          and o.success = false
      ), recent as (
        select f.monitor_id, f.region_id, r.success,
          row_number() over (
            partition by f.monitor_id, f.region_id
            order by r.window_started_at desc, r.completed_at desc
          ) as recency
        from today_failures f
        cross join lateral (
          select o.success, cr.window_started_at, o.completed_at
          from check_runs cr
          join observations o on o.check_run_id = cr.id
          where cr.monitor_id = f.monitor_id
            and o.region_id = f.region_id
            and cr.status in ('complete', 'partial')
          order by cr.window_started_at desc, o.completed_at desc
          limit 5
        ) r
      ), recovery_state as (
        select monitor_id, region_id,
          count(*) filter (where recency <= 2)::integer as first_two_count,
          bool_and(success) filter (where recency <= 2) as first_two_successful,
          count(*) filter (where recency <= 5)::integer as first_five_count,
          bool_and(success) filter (where recency <= 5) as first_five_successful
        from recent
        where recency <= 5
        group by monitor_id, region_id
      ), issue_state as (
        select tf.monitor_id, tf.region_id,
          case
            when recovery.first_five_count = 5 and recovery.first_five_successful
              then 'up'
            when recovery.first_two_count = 2 and recovery.first_two_successful
              then 'recovering'
            else 'down'
          end as state
        from today_failures tf
        join recovery_state recovery
          on recovery.monitor_id = tf.monitor_id
          and recovery.region_id = tf.region_id
      )
      select pm.monitor_id as "monitorId",
        count(distinct mr.region_id)::integer as "configuredRegionCount",
        coalesce(
          array_agg(distinct issues.region_id) filter (where issues.state = 'down'),
          array[]::region_id[]
        ) as "affectedRegionIds",
        case
          when bool_or(issues.state = 'down') then 'down'
          when bool_or(issues.state = 'recovering') then 'recovering'
          when bool_or(issues.state = 'up') then 'up'
          else null
        end as "recoveryStatus"
      from page_monitors pm
      left join monitor_regions mr on mr.monitor_id = pm.monitor_id
      left join issue_state issues on issues.monitor_id = pm.monitor_id
      group by pm.monitor_id
    `,
  );
  const currentRegionsByMonitor = new Map(
    currentRegions.map((row) => [
      row.monitorId,
      {
        configuredRegionCount: Number(row.configuredRegionCount),
        affectedRegionIds: row.affectedRegionIds ?? [],
        recoveryStatus: row.recoveryStatus,
      },
    ]),
  );
  return {
    statusPage: {
      id: statusPage.id,
      title: statusPage.title,
      publicSlug: statusPage.publicSlug,
      groups: statusPage.groups.map((group) => ({
        id: group.id,
        title: group.title,
        monitors: group.monitors.map((monitor) => {
          const monitorDays = byMonitor.get(monitor.id) ?? new Map<string, StatusPageDailyRow>();
          return {
            id: monitor.id,
            name: monitor.name,
            url: monitor.url,
            publicSlug: monitor.publicSlug,
            ...(currentRegionsByMonitor.get(monitor.id) ?? {
              configuredRegionCount: 0,
              affectedRegionIds: [],
              recoveryStatus: null,
            }),
            ...summarizeMonitorUptime(monitorDays, dayKeys),
          };
        }),
      })),
    },
  };
}

async function getMonitor(db: Database, id: string): Promise<MonitorRow | null> {
  const monitors = await rows<MonitorRow>(
    db,
    sql`select id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled, dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic", public_slug as "publicSlug", outage_threshold as "outageThreshold", recovery_threshold as "recoveryThreshold", repeat_notification_minutes as "repeatNotificationMinutes", coalesce(array(select notification_service_id from monitor_notification_services where monitor_id = monitors.id order by notification_service_id), array[]::uuid[]) as "notificationServiceIds", created_at as "createdAt", updated_at as "updatedAt" from monitors where id = ${id} limit 1`,
  );
  return monitors[0] ?? null;
}
async function getNotificationService(
  db: SqlExecutor,
  id: string,
): Promise<NotificationServiceRow | null> {
  const services = await rows<NotificationServiceRow>(
    db,
    sql`select id, name, provider, enabled, config, created_at as "createdAt", updated_at as "updatedAt" from notification_services where id = ${id} limit 1`,
  );
  return services[0] ?? null;
}
async function getNotificationServiceForUpdate(
  db: SqlExecutor,
  id: string,
): Promise<NotificationServiceRow | null> {
  const services = await rows<NotificationServiceRow>(
    db,
    sql`select id, name, provider, enabled, config, created_at as "createdAt", updated_at as "updatedAt" from notification_services where id = ${id} for update`,
  );
  return services[0] ?? null;
}

function serializeNotificationService(row: NotificationServiceRow): NotificationService {
  let config: NotificationService['config'];
  switch (row.provider) {
    case 'telegram':
      config = { chatId: valueString(row.config.chatId) };
      break;
    case 'resend':
      config = {
        from: valueString(row.config.from),
        to: valueStringArray(row.config.to),
        ...optionalPublicString('subject', row.config.subject),
      };
      break;
    case 'gotify':
      config = {
        serverUrl: valueString(row.config.serverUrl),
        priority: valueNumber(row.config.priority),
      };
      break;
    case 'smtp':
      config = {
        host: valueString(row.config.host),
        port: valueNumber(row.config.port),
        security: row.config.security as 'tls' | 'starttls' | 'none',
        from: valueString(row.config.from),
        to: valueStringArray(row.config.to),
        ...optionalPublicString('username', row.config.username),
        ...optionalPublicString('subject', row.config.subject),
      };
      break;
    case 'home-assistant':
      config = {
        serverUrl: valueString(row.config.serverUrl),
        service: valueString(row.config.service),
      };
      break;
    case 'discord':
    case 'webhook':
      config = {};
      break;
    default:
      throw httpError(
        500,
        'unsupported_provider',
        `Unsupported notification provider: ${row.provider}`,
      );
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    enabled: row.enabled,
    config,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mergeNotificationConfig(
  provider: NotificationServiceRow['provider'],
  current: Record<string, unknown>,
  update: unknown,
): Record<string, unknown> {
  if (!update || typeof update !== 'object') return current;
  const next = update as Record<string, unknown>;
  assertProviderConfigKeys(provider, next);
  switch (provider) {
    case 'telegram':
      return cleanConfig(
        telegramConfigSchema.parse({
          botToken: retainedSecret(next.botToken, current.botToken),
          chatId: next.chatId ?? current.chatId,
        }),
      );
    case 'discord':
      return cleanConfig(
        discordConfigSchema.parse({
          webhookUrl: retainedSecret(next.webhookUrl, current.webhookUrl),
        }),
      );
    case 'resend':
      return cleanConfig(
        resendConfigSchema.parse({
          apiKey: retainedSecret(next.apiKey, current.apiKey),
          from: next.from ?? current.from,
          to: next.to ?? current.to,
          subject: optionalText(next, 'subject', current.subject),
        }),
      );
    case 'gotify':
      return cleanConfig(
        gotifyConfigSchema.parse({
          serverUrl: next.serverUrl ?? current.serverUrl,
          applicationToken: retainedSecret(next.applicationToken, current.applicationToken),
          priority: next.priority ?? current.priority,
        }),
      );
    case 'webhook':
      return cleanConfig(
        webhookConfigSchema.parse({
          webhookUrl: retainedSecret(next.webhookUrl, current.webhookUrl),
          bearerToken: retainedSecret(next.bearerToken, current.bearerToken),
        }),
      );
    case 'smtp':
      return cleanConfig(
        smtpConfigSchema.parse({
          host: next.host ?? current.host,
          port: next.port ?? current.port,
          security: next.security ?? current.security,
          username: optionalText(next, 'username', current.username),
          password: retainedSecret(next.password, current.password, false),
          from: next.from ?? current.from,
          to: next.to ?? current.to,
          subject: optionalText(next, 'subject', current.subject),
        }),
      );
    case 'home-assistant':
      return cleanConfig(
        homeAssistantConfigSchema.parse({
          serverUrl: next.serverUrl ?? current.serverUrl,
          accessToken: retainedSecret(next.accessToken, current.accessToken),
          service: next.service ?? current.service,
        }),
      );
    default:
      throw httpError(
        400,
        'unsupported_provider',
        `Unsupported notification provider: ${provider}`,
      );
  }
}

const providerConfigKeys: Record<SupportedNotificationProviderKind, ReadonlySet<string>> = {
  telegram: new Set(['botToken', 'chatId']),
  discord: new Set(['webhookUrl']),
  resend: new Set(['apiKey', 'from', 'to', 'subject']),
  gotify: new Set(['serverUrl', 'applicationToken', 'priority']),
  webhook: new Set(['webhookUrl', 'bearerToken']),
  smtp: new Set(['host', 'port', 'security', 'username', 'password', 'from', 'to', 'subject']),
  'home-assistant': new Set(['serverUrl', 'accessToken', 'service']),
};

function assertProviderConfigKeys(
  provider: NotificationProviderKind,
  config: Record<string, unknown>,
) {
  assertSupportedProvider(provider);
  const supportedKeys = providerConfigKeys[provider];
  const invalid = Object.keys(config).filter((key) => !supportedKeys.has(key));
  if (invalid.length > 0) {
    throw httpError(400, 'validation_error', 'Request configuration does not match provider');
  }
}

function assertSupportedProvider(
  provider: NotificationProviderKind,
): asserts provider is SupportedNotificationProviderKind {
  if (!(provider in providerConfigKeys)) {
    throw httpError(400, 'unsupported_provider', `Unsupported notification provider: ${provider}`);
  }
}

function retainedSecret(next: unknown, current: unknown, trim = true) {
  if (typeof next !== 'string') return current;
  const candidate = trim ? next.trim() : next;
  return candidate.length > 0 ? candidate : current;
}

function optionalText(next: Record<string, unknown>, key: string, current: unknown) {
  if (!(key in next)) return current;
  const value = next[key];
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanConfig(config: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

function valueString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function valueStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function valueNumber(value: unknown) {
  return typeof value === 'number' ? value : Number(value);
}

function optionalPublicString<K extends 'subject' | 'username'>(key: K, value: unknown) {
  return typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {};
}
async function getPublicMonitor(db: Database, reference: string): Promise<MonitorRow | null> {
  const monitors = await rows<MonitorRow>(
    db,
    sql`select id, name, url, interval_seconds as "intervalSeconds", timeout_ms as "timeoutMs", enabled, dns_diagnostics_enabled as "dnsDiagnosticsEnabled", is_public as "isPublic", public_slug as "publicSlug", outage_threshold as "outageThreshold", recovery_threshold as "recoveryThreshold", repeat_notification_minutes as "repeatNotificationMinutes", coalesce(array(select notification_service_id from monitor_notification_services where monitor_id = monitors.id order by notification_service_id), array[]::uuid[]) as "notificationServiceIds", created_at as "createdAt", updated_at as "updatedAt" from monitors where (id::text = ${reference} or public_slug = ${reference}) and (is_public = true or exists (select 1 from status_page_monitors where monitor_id = monitors.id)) limit 1`,
  );
  return monitors[0] ?? null;
}
async function assertPublicSlugAvailable(
  db: SqlExecutor,
  publicSlug: string | null,
  excludedMonitorId?: string,
) {
  if (!publicSlug) return;
  const conflicts = await rows<{ id: string }>(
    db,
    sql`select id from monitors where public_slug = ${publicSlug} and (${excludedMonitorId ?? null}::uuid is null or id <> ${excludedMonitorId ?? null}::uuid) limit 1`,
  );
  if (conflicts[0]) {
    throw httpError(409, 'slug_conflict', 'That public monitor slug is already in use');
  }
}
async function getRegionIds(db: Database, monitorId: string): Promise<RegionId[]> {
  const selected = await rows<{ regionId: RegionId }>(
    db,
    sql`select region_id as "regionId" from monitor_regions where monitor_id = ${monitorId} order by region_id`,
  );
  return selected.map((row) => row.regionId);
}
async function assertNotificationServicesExist(db: SqlExecutor, serviceIds: readonly string[]) {
  if (serviceIds.length === 0) return;
  const uniqueIds = [...new Set(serviceIds)];
  const found = await rows<{ id: string }>(
    db,
    sql`select id from notification_services where id in (${sql.join(
      uniqueIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  if (found.length !== uniqueIds.length) {
    throw httpError(
      400,
      'invalid_notification_service',
      'One or more notification services do not exist',
    );
  }
}

async function replaceMonitorNotificationServices(
  db: SqlExecutor,
  monitorId: string,
  serviceIds: readonly string[],
) {
  await db.execute(sql`delete from monitor_notification_services where monitor_id = ${monitorId}`);
  for (const serviceId of serviceIds) {
    await db.execute(
      sql`insert into monitor_notification_services (monitor_id, notification_service_id) values (${monitorId}, ${serviceId})`,
    );
  }
}

async function cancelAllPendingNotificationDeliveries(db: SqlExecutor, serviceId: string) {
  await db.execute(sql`
    update notification_deliveries set status = 'cancelled', lease_until = null
    where notification_service_id = ${serviceId} and status in ('pending', 'sending')
  `);
}

async function invalidateNotificationStateForService(db: SqlExecutor, serviceId: string) {
  await db.execute(sql`
    update monitor_notification_state set config_fingerprint = 'invalidated', updated_at = now()
    where monitor_id in (
      select monitor_id from monitor_notification_services
      where notification_service_id = ${serviceId}
    )
  `);
}

async function cancelAllMonitorNotificationDeliveries(db: SqlExecutor, monitorId: string) {
  await db.execute(sql`
    update notification_deliveries set status = 'cancelled', lease_until = null
    where monitor_id = ${monitorId} and status in ('pending', 'sending')
  `);
}

async function invalidateMonitorNotificationState(db: SqlExecutor, monitorId: string) {
  await db.execute(sql`
    update monitor_notification_state set config_fingerprint = 'invalidated', updated_at = now()
    where monitor_id = ${monitorId}
  `);
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}
async function monitorSummary(
  db: Database,
  row: MonitorRow,
  log: EndpointEvidenceLog,
): Promise<MonitorSummary> {
  const regionIds = await getRegionIds(db, row.id);
  const notificationServiceIds = row.notificationServiceIds ?? [];
  const runs = await rows<{ id: string; windowStartedAt: Date | string }>(
    db,
    sql`select id, window_started_at as "windowStartedAt" from check_runs where monitor_id = ${row.id} and status in ('complete', 'partial') order by window_started_at desc limit 1`,
  );
  // Do not show pre-edit results as evidence for the monitor's new configuration.
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
    publicSlug: row.publicSlug,
    notificationServiceIds,
    outageThreshold: row.outageThreshold ?? 3,
    recoveryThreshold: row.recoveryThreshold ?? 2,
    repeatNotificationMinutes: row.repeatNotificationMinutes ?? null,
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
  const {
    dnsDiagnosticsEnabled: _dnsDiagnosticsEnabled,
    notificationServiceIds: _notificationServiceIds,
    outageThreshold: _outageThreshold,
    recoveryThreshold: _recoveryThreshold,
    repeatNotificationMinutes: _repeatNotificationMinutes,
    ...monitor
  } = summary.monitor;
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
        avg(coalesce(response_ms, case when error_code = 'timeout' then total_ms end))::double precision
          as "responseMs",
        -- A bucket is successful only when every contributing observation succeeded.
        bool_and(success) as success
      from observations
      where monitor_id = ${id} and started_at >= ${since.toISOString()}
      group by 1, 2
      order by 1 asc, 2 asc
    `,
  );
  const aggregatePoints = await rows<AggregateLatencyRow>(
    db,
    sql`
      with regional_buckets as (
        select
          date_bin(${aggregateLatencyBucketIntervals[range]}::interval, started_at, '1970-01-01T00:00:00.000Z'::timestamptz)
            as bucket,
          region_id,
          avg(coalesce(response_ms, case when error_code = 'timeout' then total_ms end))
            filter (where response_ms is not null or (error_code = 'timeout' and total_ms is not null))
            as response_ms,
          bool_and(success) as success
        from observations
        where monitor_id = ${id} and started_at >= ${since.toISOString()}
        group by 1, 2
      )
      select bucket as "observedAt",
        avg(response_ms)::double precision as "responseMs",
        bool_and(success) as success
      from regional_buckets
      group by bucket
      order by bucket asc
    `,
  );
  const exactStats = await rows<PublicLatencyStatsRow>(
    db,
    sql`
      select region_id as "regionId", count(*) as "sampleCount",
        count(*) filter (where success) as "successCount",
        percentile_disc(0.5) within group (
          order by coalesce(response_ms, case when error_code = 'timeout' then total_ms end)
        ) filter (
          where response_ms is not null or (error_code = 'timeout' and total_ms is not null)
        ) as "p50Ms",
        percentile_disc(0.95) within group (
          order by coalesce(response_ms, case when error_code = 'timeout' then total_ms end)
        ) filter (
          where response_ms is not null or (error_code = 'timeout' and total_ms is not null)
        ) as "p95Ms",
        percentile_disc(0.99) within group (
          order by coalesce(response_ms, case when error_code = 'timeout' then total_ms end)
        ) filter (
          where response_ms is not null or (error_code = 'timeout' and total_ms is not null)
        ) as "p99Ms"
      from observations
      where monitor_id = ${id} and started_at >= ${since.toISOString()}
      group by region_id
    `,
  );
  const [aggregateStatsRow] = await rows<AggregateLatencyStatsRow>(
    db,
    sql`
      with regional_stats as (
        select region_id,
          avg(coalesce(response_ms, case when error_code = 'timeout' then total_ms end))
            filter (where response_ms is not null or (error_code = 'timeout' and total_ms is not null))
            as average_response_ms,
          max(coalesce(response_ms, case when error_code = 'timeout' then total_ms end))
            filter (where response_ms is not null or (error_code = 'timeout' and total_ms is not null))
            as maximum_response_ms,
          min(coalesce(response_ms, case when error_code = 'timeout' then total_ms end))
            filter (where response_ms is not null or (error_code = 'timeout' and total_ms is not null))
            as minimum_response_ms
        from observations
        where monitor_id = ${id} and started_at >= ${since.toISOString()}
        group by region_id
      )
      select avg(average_response_ms)::double precision as "averageResponseMs",
        max(maximum_response_ms)::double precision as "maximumResponseMs",
        (
          select region_id
          from observations
          where monitor_id = ${id} and started_at >= ${since.toISOString()}
            and (response_ms is not null or (error_code = 'timeout' and total_ms is not null))
          order by coalesce(response_ms, case when error_code = 'timeout' then total_ms end) desc,
            started_at desc, id desc
          limit 1
        ) as "maximumResponseRegionId",
        min(minimum_response_ms)::double precision as "minimumResponseMs"
      from regional_stats
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
  return {
    range,
    points: points.map(serializeLatencyPoint),
    stats,
    aggregatePoints: aggregatePoints.map((point) => ({
      ...point,
      observedAt: iso(point.observedAt),
      responseMs: point.responseMs === null ? null : Number(point.responseMs),
    })),
    aggregateStats: {
      averageResponseMs:
        aggregateStatsRow?.averageResponseMs === null ||
        aggregateStatsRow?.averageResponseMs === undefined
          ? null
          : Number(aggregateStatsRow.averageResponseMs),
      maximumResponseMs:
        aggregateStatsRow?.maximumResponseMs === null ||
        aggregateStatsRow?.maximumResponseMs === undefined
          ? null
          : Number(aggregateStatsRow.maximumResponseMs),
      maximumResponseRegionId: aggregateStatsRow?.maximumResponseRegionId ?? null,
      minimumResponseMs:
        aggregateStatsRow?.minimumResponseMs === null ||
        aggregateStatsRow?.minimumResponseMs === undefined
          ? null
          : Number(aggregateStatsRow.minimumResponseMs),
    },
  };
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
