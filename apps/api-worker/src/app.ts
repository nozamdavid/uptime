import {
  all,
  batch,
  first,
  notificationPreview,
  nowIso,
  randomId,
  recordNotificationHistory,
  run,
  type D1Database,
} from '@uptime/cloudflare';
import {
  badgeCreateSchema,
  calculateTargetChecksPerDay,
  estimateRequestSchema,
  monitorBulkBadgeUpdateSchema,
  monitorBulkFrequencyUpdateSchema,
  monitorCreateSchema,
  monitorUpdateSchema,
  notificationServiceCreateSchema,
  notificationServiceUpdateSchema,
  regionIdSchema,
  statusPageSaveSchema,
  type RegionId,
  type NotificationHistoryEntry,
  type StatusPageSave,
} from '@uptime/contracts';
import { z } from 'zod';

import {
  createSession,
  deleteSession,
  findAdmin,
  lookupSession,
  touchSession,
  verifyAdminPassword,
  type SessionAdmin,
} from './auth.js';
import { openProviderConfig, sealProviderConfig } from './credentials.js';
import { parseDnsDiagnosticRow } from './dns-diagnostics.js';
import { HttpErrorLike, SESSION_COOKIE, parseCookies } from './http.js';
import { mergeNotificationConfig, serializeNotificationService } from './notification-services.js';
import { createNotificationProvider, providerTestError } from './providers.js';
import {
  badgeExists,
  getMonitor,
  getMonitorRegions,
  getPublicMonitor,
  getPublicStatusPage,
  getStatusPage,
  latencyPayload,
  listDnsDiagnostics,
  listObservations,
  listStatusPageSummaries,
  monitorSelect,
  monitorSummary,
  monitorSummaries,
  monitorUptimePayload,
  nextBoundary,
  notificationServicesExist,
  publicStatusPagePayload,
  toPublicMonitorSummary,
  type RangeKey,
} from './queries.js';
import { Router, type RouteContext } from './router.js';
import { assertPublicHttpUrl } from './security.js';
import { base64UrlDecodeJson, base64UrlEncodeJson, invalidCursor } from './stored-json.js';
import { parseNotificationServiceIds } from './types.js';

import type { ApiConfig } from './env.js';
import type { MonitorRow, NotificationServiceRow } from './types.js';

export interface AppEnv {
  config: ApiConfig;
  db: D1Database;
  now: () => Date;
  log: LogSink;
}

export interface LogSink {
  warn: (bindings: Record<string, unknown>, message: string) => void;
  error?: (bindings: Record<string, unknown>, message: string) => void;
}

export interface AppDependencies {
  now?: () => Date;
  notificationFetch?: typeof fetch;
  log?: LogSink;
}

const idSchema = z.object({ id: z.uuid() });
const publicReferenceSchema = z.object({
  id: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9.-]+$/),
});
const rangeSchema = z.enum(['1h', '24h', '7d', '30d']).default('24h');

function historyExternalUrl(provider: string, value: string | null) {
  if (!value || provider !== 'bluesky') return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'bsky.app' ||
      url.username ||
      url.password ||
      url.port
    )
      return value;
    const [, profile, encodedDid, post, encodedRkey] = url.pathname.split('/');
    if (
      url.pathname.split('/').length !== 5 ||
      profile !== 'profile' ||
      post !== 'post' ||
      !encodedDid ||
      !encodedRkey
    )
      return value;
    if (!/^did%3a/i.test(encodedDid)) return value;
    const did = decodeURIComponent(encodedDid);
    const rkey = decodeURIComponent(encodedRkey);
    if (
      !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(did) ||
      !/^[A-Za-z0-9._~:-]+$/.test(rkey) ||
      rkey === '.' ||
      rkey === '..'
    )
      return value;
    return `https://bsky.app/profile/${did}/post/${rkey}`;
  } catch {
    return value;
  }
}
const diagnosticRangeSchema = z.enum(['7d', '30d']).default('7d');
const cursorObjectSchema = z.object({ startedAt: z.string().datetime(), id: z.uuid() });
const dnsCursorObjectSchema = z.object({ requestedAt: z.string().datetime(), id: z.uuid() });
const notificationHistoryCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.uuid(),
});

interface NotificationHistoryRow {
  id: string;
  notification_service_id: string;
  monitor_id: string | null;
  monitor_name: string;
  monitor_url: string | null;
  provider: NotificationHistoryEntry['provider'];
  kind: NotificationHistoryEntry['kind'];
  status: NotificationHistoryEntry['status'];
  created_at: string;
  text: string;
  external_url: string | null;
  error: string | null;
  preview: string;
}

function notificationHistoryEntry(row: NotificationHistoryRow): NotificationHistoryEntry {
  return {
    id: row.id,
    notificationServiceId: row.notification_service_id,
    monitorId: row.monitor_id,
    monitorName: row.monitor_name,
    monitorUrl: row.kind === 'test' ? null : row.monitor_url,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    text: row.text,
    externalUrl: historyExternalUrl(row.provider, row.external_url),
    error: row.error,
    preview: JSON.parse(row.preview) as NotificationHistoryEntry['preview'],
  };
}

function parseNotificationHistoryCursor(cursorText: string | null) {
  if (cursorText === null) return null;
  if (cursorText.length > 512) throw invalidCursor();
  try {
    return notificationHistoryCursorSchema.parse(base64UrlDecodeJson(cursorText));
  } catch {
    throw invalidCursor();
  }
}

async function readNotificationHistory(
  db: D1Database,
  serviceId: string | null,
  cursorText: string | null,
) {
  const cursor = parseNotificationHistoryCursor(cursorText);
  const serviceFilter = serviceId === null ? '1 = 1' : 'notification_service_id = ?';
  const serviceValues = serviceId === null ? [] : [serviceId];
  const rows = await all<NotificationHistoryRow>(
    db,
    `SELECT id, notification_service_id, monitor_id, monitor_name, monitor_url,
            provider, kind, status, created_at, text, external_url, error, preview
     FROM notification_history
     WHERE ${serviceFilter}
       AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC
     LIMIT 26`,
    [
      ...serviceValues,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
    ],
  );
  const page = rows.slice(0, 25);
  return {
    entries: page.map(notificationHistoryEntry),
    nextCursor:
      rows.length > 25 && page.length > 0
        ? base64UrlEncodeJson({
            createdAt: page[page.length - 1]!.created_at,
            id: page[page.length - 1]!.id,
          })
        : null,
  };
}
const observationQuerySchema = z.object({
  range: rangeSchema,
  regionId: regionIdSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const dnsDiagnosticQuerySchema = z.object({
  range: diagnosticRangeSchema,
  regionId: regionIdSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Build the router with all API routes registered. */
export function createApiRouter(deps: AppDependencies = {}): Router<AppEnv> {
  const router = new Router<AppEnv>();
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.notificationFetch ?? fetch;
  const log: LogSink = deps.log ?? { warn: () => undefined };

  const requireAdmin = async (c: RouteContext<AppEnv>): Promise<SessionAdmin> => {
    const admin = await resolveAdmin(c, now);
    if (!admin) throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
    return admin;
  };

  router.add('GET', '/health', async (c) => {
    const row = await first<{ ok: number }>(c.env.db, 'SELECT 1 AS ok');
    return json({ status: row?.ok === 1 ? 'ok' : 'degraded' });
  });

  // ---------------------------------------------------------------- auth ----
  router.add('POST', '/api/auth/login', async (c) => {
    const body = z
      .object({ password: z.string().min(1).max(1024) })
      .parse(await readJson(c.request));
    const { db, config } = c.env;
    const admin = await findAdmin(db);
    if (!admin) throw new HttpErrorLike(401, 'invalid_credentials', 'Invalid password');
    const verification = await verifyAdminPassword(admin.password_hash, body.password);
    if (!verification.hashIsValid) {
      throw new HttpErrorLike(
        500,
        'auth_configuration_error',
        'Authentication is temporarily unavailable',
      );
    }
    if (!verification.matches)
      throw new HttpErrorLike(401, 'invalid_credentials', 'Invalid password');
    const { token, expiresAt } = await createSession(db, config, admin.id, now());
    return json(
      { admin: { id: admin.id, email: admin.email }, expiresAt: expiresAt.toISOString() },
      { headers: { 'set-cookie': serializeSessionCookie(config, token, expiresAt) } },
    );
  });

  router.add('POST', '/api/auth/logout', async (c) => {
    const { db, config } = c.env;
    const token = parseCookies(c.request.headers.get('cookie'))[SESSION_COOKIE];
    if (token) await deleteSession(db, config, token);
    return noContent({ headers: { 'set-cookie': clearSessionCookie(config) } });
  });

  router.add('GET', '/api/auth/session', async (c) => {
    const admin = await resolveAdmin(c, now);
    if (!admin) throw new HttpErrorLike(401, 'unauthorized', 'Authentication is required');
    return json({ admin });
  });

  // ------------------------------------------------------------- regions ----
  router.add('GET', '/api/regions', async (c) => json({ regions: c.env.config.enabledRegions }));

  router.add('POST', '/api/estimates', async (c) => {
    const input = estimateRequestSchema.parse(await readJson(c.request));
    return json(calculateTargetChecksPerDay(input));
  });

  // ------------------------------------------------- notification services --
  router.add('GET', '/api/notification-history', async (c) => {
    await requireAdmin(c);
    return json(await readNotificationHistory(c.env.db, null, c.url.searchParams.get('cursor')));
  });

  router.add('GET', '/api/notification-services', async (c) => {
    await requireAdmin(c);
    const { db, config } = c.env;
    const rows = await all<NotificationServiceRow>(
      db,
      'SELECT * FROM notification_services ORDER BY created_at DESC',
    );
    const services = await Promise.all(
      rows.map((row) => serializeNotificationService(config.credentialEncryptionSecret, row)),
    );
    return json({ services });
  });

  router.add('POST', '/api/notification-services', async (c) => {
    await requireAdmin(c);
    const { db, config } = c.env;
    const input = notificationServiceCreateSchema.parse(await readJson(c.request));
    const id = randomId();
    const timestamp = nowIso(now());
    const encrypted = await sealProviderConfig(config.credentialEncryptionSecret, input.config);
    await run(
      db,
      `INSERT INTO notification_services (id, name, provider, enabled, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.name, input.provider, input.enabled ? 1 : 0, encrypted, timestamp, timestamp],
    );
    const row = await first<NotificationServiceRow>(
      db,
      'SELECT * FROM notification_services WHERE id = ?',
      [id],
    );
    if (!row) throw new HttpErrorLike(500, 'internal_error', 'Notification service insert failed');
    return json(
      { service: await serializeNotificationService(config.credentialEncryptionSecret, row) },
      { status: 201 },
    );
  });

  router.add('PATCH', '/api/notification-services/:id', async (c) => {
    await requireAdmin(c);
    const { db, config } = c.env;
    const { id } = idSchema.parse(c.params);
    const input = notificationServiceUpdateSchema.parse(await readJson(c.request));
    const current = await first<NotificationServiceRow>(
      db,
      'SELECT * FROM notification_services WHERE id = ?',
      [id],
    );
    if (!current) throw new HttpErrorLike(404, 'not_found', 'Notification service was not found');
    const { config: currentConfig } = await openProviderConfig(
      config.credentialEncryptionSecret,
      current.config,
    );
    const merged = mergeNotificationConfig(current.provider, currentConfig, input.config);
    const configurationChanged = JSON.stringify(merged) !== JSON.stringify(currentConfig);
    const nextEnabled = input.enabled ?? current.enabled === 1;
    const enabledChanged = (current.enabled === 1) !== nextEnabled;
    const encrypted = await sealProviderConfig(config.credentialEncryptionSecret, merged);
    const timestamp = nowIso(now());
    const statements: { sql: string; values: unknown[] }[] = [
      {
        sql: 'UPDATE notification_services SET name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?',
        values: [input.name ?? current.name, nextEnabled ? 1 : 0, encrypted, timestamp, id],
      },
    ];
    if (enabledChanged || configurationChanged) {
      statements.push(
        {
          sql: `UPDATE notification_deliveries SET status = 'cancelled', lease_until = NULL, lease_token = NULL
                WHERE notification_service_id = ? AND status IN ('pending', 'sending')`,
          values: [id],
        },
        {
          sql: `UPDATE monitor_notification_state SET config_fingerprint = 'invalidated', updated_at = ?
                WHERE monitor_id IN (
                  SELECT monitor_id FROM monitor_notification_services WHERE notification_service_id = ?
                )`,
          values: [timestamp, id],
        },
      );
    }
    await batch(db, statements);
    const updated = await first<NotificationServiceRow>(
      db,
      'SELECT * FROM notification_services WHERE id = ?',
      [id],
    );
    if (!updated) throw new HttpErrorLike(404, 'not_found', 'Notification service was not found');
    return json({
      service: await serializeNotificationService(config.credentialEncryptionSecret, updated),
    });
  });

  router.add('DELETE', '/api/notification-services/:id', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const { id } = idSchema.parse(c.params);
    const result = await run(db, 'DELETE FROM notification_services WHERE id = ?', [id]);
    if (result.meta.changes === 0) {
      throw new HttpErrorLike(404, 'not_found', 'Notification service was not found');
    }
    return noContent();
  });

  router.add('GET', '/api/notification-services/:id/history', async (c) => {
    await requireAdmin(c);
    const { id } = idSchema.parse(c.params);
    const exists = await first<{ id: string }>(
      c.env.db,
      'SELECT id FROM notification_services WHERE id = ?',
      [id],
    );
    if (!exists) throw new HttpErrorLike(404, 'not_found', 'Notification service was not found');

    return json(await readNotificationHistory(c.env.db, id, c.url.searchParams.get('cursor')));
  });

  router.add('POST', '/api/notification-services/:id/test', async (c) => {
    await requireAdmin(c);
    const { db, config } = c.env;
    const { id } = idSchema.parse(c.params);
    const service = await first<NotificationServiceRow>(
      db,
      'SELECT * FROM notification_services WHERE id = ?',
      [id],
    );
    if (!service) throw new HttpErrorLike(404, 'not_found', 'Notification service was not found');
    const { config: serviceConfig } = await openProviderConfig(
      config.credentialEncryptionSecret,
      service.config,
    );
    const message = {
      kind: 'test' as const,
      monitorName: 'Uptime notification test',
      monitorUrl: 'https://example.com',
      occurredAt: now().toISOString(),
      outageStartedAt: null,
    };
    const fallback = notificationPreview(service.provider, serviceConfig, message);
    const recordAttempt = async (
      status: 'sent' | 'failed',
      text: string,
      externalUrl: string | null,
      error: string | null,
    ) => {
      try {
        await recordNotificationHistory(db, {
          notificationServiceId: id,
          monitorId: null,
          monitorName: message.monitorName,
          monitorUrl: null,
          provider: service.provider,
          kind: 'test',
          status,
          createdAt: now(),
          text,
          externalUrl,
          error,
          preview: fallback.preview,
        });
      } catch {
        log.warn(
          { event: 'notification_history_write_failed', notificationServiceId: id },
          'Notification history write failed',
        );
      }
    };
    try {
      const receipt = await createNotificationProvider(
        service.provider,
        serviceConfig,
        fetchImpl,
      ).send(message);
      await recordAttempt('sent', receipt.text, receipt.externalUrl, null);
    } catch (error) {
      const safeError = providerTestError(error);
      await recordAttempt('failed', fallback.text, null, safeError.message);
      throw safeError;
    }
    return json({ success: true });
  });

  // --------------------------------------------------------------- badges ---
  router.add('GET', '/api/badges', async (c) => {
    await requireAdmin(c);
    return json({
      badges: await all(c.env.db, 'SELECT id, name, color FROM badges ORDER BY lower(name), id'),
    });
  });

  router.add('POST', '/api/badges', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const input = badgeCreateSchema.parse(await readJson(c.request));
    const existing = await first<{ id: string; name: string; color: string }>(
      db,
      'SELECT id, name, color FROM badges WHERE lower(name) = lower(?) LIMIT 1',
      [input.name],
    );
    if (existing) return json({ badge: existing });
    const colors = [
      '#2563eb',
      '#7c3aed',
      '#db2777',
      '#dc2626',
      '#ea580c',
      '#ca8a04',
      '#16a34a',
      '#059669',
      '#0891b2',
      '#4f46e5',
    ] as const;
    const random = new Uint8Array(1);
    crypto.getRandomValues(random);
    const color = colors[random[0]! % colors.length]!;
    const id = randomId();
    await run(db, 'INSERT INTO badges (id, name, color) VALUES (?, ?, ?)', [id, input.name, color]);
    return json({ badge: { id, name: input.name, color } }, { status: 201 });
  });

  // -------------------------------------------------------------- monitors --
  router.add('GET', '/api/monitors', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const rows = await all<MonitorRow>(db, `${monitorSelect} ORDER BY m.created_at DESC`);
    return json({ monitors: await monitorSummaries(db, rows, log) });
  });

  router.add('POST', '/api/monitors', async (c) => {
    await requireAdmin(c);
    const { db, config } = c.env;
    const input = monitorCreateSchema.parse(await readJson(c.request));
    assertRegionsEnabled(config, input.regionIds);
    assertPublicHttpUrl(input.url);
    await assertMonitorSlugAvailable(db, input.publicSlug ?? null, null);
    await assertNotificationServicesExist(db, input.notificationServiceIds ?? []);
    await assertBadgeExists(db, input.badgeId ?? null);
    const id = randomId();
    const timestamp = nowIso(now());
    const thresholds = input.uptimeThresholds ?? { green: 99.5, lightGreen: 99, orange: 90 };
    const nextCheckAt = nextBoundary(now(), input.intervalSeconds).toISOString();
    const statements: { sql: string; values: unknown[] }[] = [
      {
        sql: `INSERT INTO monitors (id, name, url, interval_seconds, timeout_ms, enabled,
                dns_diagnostics_enabled, is_public, public_slug, badge_id, uptime_thresholds,
                outage_threshold, recovery_threshold, repeat_notification_minutes, next_check_at,
                created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [
          id,
          input.name ?? null,
          input.url,
          input.intervalSeconds,
          input.timeoutMs,
          input.enabled ? 1 : 0,
          input.dnsDiagnosticsEnabled ? 1 : 0,
          input.isPublic ? 1 : 0,
          input.publicSlug ?? null,
          input.badgeId ?? null,
          JSON.stringify(thresholds),
          input.outageThreshold ?? 3,
          input.recoveryThreshold ?? 2,
          input.repeatNotificationMinutes ?? null,
          nextCheckAt,
          timestamp,
          timestamp,
        ],
      },
    ];
    for (const regionId of input.regionIds) {
      statements.push({
        sql: 'INSERT INTO monitor_regions (monitor_id, region_id) VALUES (?, ?)',
        values: [id, regionId],
      });
    }
    for (const serviceId of input.notificationServiceIds ?? []) {
      statements.push({
        sql: 'INSERT INTO monitor_notification_services (monitor_id, notification_service_id) VALUES (?, ?)',
        values: [id, serviceId],
      });
    }
    await batch(db, statements);
    const row = await getMonitor(db, id);
    if (!row) throw new HttpErrorLike(500, 'internal_error', 'Monitor insert failed');
    return json({ summary: await monitorSummary(db, row, log) }, { status: 201 });
  });

  router.add('PATCH', '/api/monitors/bulk-frequency', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const input = monitorBulkFrequencyUpdateSchema.parse(await readJson(c.request));
    const ids = [...new Set(input.monitorIds)];
    const timestamp = nowIso(now());
    const nextCheckAt = nextBoundary(now(), input.intervalSeconds).toISOString();
    // D1 caps a statement at 100 bound parameters, so expand the id list from a
    // single JSON bind with json_each instead of one `?` per monitor. The
    // existence guard ensures a missing monitor leaves every row untouched
    // before returning the 404.
    const updated = await all<{ id: string }>(
      db,
      `UPDATE monitors SET interval_seconds = ?, next_check_at = ?, updated_at = ?
       WHERE id IN (SELECT value FROM json_each(?))
         AND (SELECT count(*) FROM monitors WHERE id IN (SELECT value FROM json_each(?))) = ?
       RETURNING id`,
      [
        input.intervalSeconds,
        nextCheckAt,
        timestamp,
        JSON.stringify(ids),
        JSON.stringify(ids),
        ids.length,
      ],
    );
    if (updated.length !== ids.length) {
      throw new HttpErrorLike(404, 'not_found', 'One or more monitors were not found');
    }
    return json({ updatedCount: updated.length });
  });

  router.add('PATCH', '/api/monitors/bulk-badge', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const input = monitorBulkBadgeUpdateSchema.parse(await readJson(c.request));
    if (input.badgeId) await assertBadgeExists(db, input.badgeId);
    const ids = [...new Set(input.monitorIds)];
    const updated = await all<{ id: string }>(
      db,
      `UPDATE monitors SET badge_id = ?, updated_at = ?
       WHERE id IN (SELECT value FROM json_each(?))
         AND (SELECT count(*) FROM monitors WHERE id IN (SELECT value FROM json_each(?))) = ?
       RETURNING id`,
      [input.badgeId, nowIso(now()), JSON.stringify(ids), JSON.stringify(ids), ids.length],
    );
    if (updated.length !== ids.length) {
      throw new HttpErrorLike(404, 'not_found', 'One or more monitors were not found');
    }
    return json({ updatedCount: updated.length });
  });

  router.add('GET', '/api/monitors/:id', async (c) => {
    await requireAdmin(c);
    const { id } = idSchema.parse(c.params);
    const monitor = await getMonitor(c.env.db, id);
    if (!monitor) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json({ summary: await monitorSummary(c.env.db, monitor, log) });
  });

  router.add('PATCH', '/api/monitors/:id', async (c) => {
    await requireAdmin(c);
    const { db, config } = c.env;
    const { id } = idSchema.parse(c.params);
    const current = await getMonitor(db, id);
    if (!current) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    const update = monitorUpdateSchema.parse(await readJson(c.request));
    const currentRegionIds = await getMonitorRegions(db, id);
    const currentNotificationIds = parseNotificationServiceIds(current.notification_service_ids);
    const merged = monitorCreateSchema.parse({
      name: current.name ?? undefined,
      url: current.url,
      regionIds: currentRegionIds,
      intervalSeconds: current.interval_seconds,
      timeoutMs: current.timeout_ms,
      enabled: current.enabled === 1,
      dnsDiagnosticsEnabled: current.dns_diagnostics_enabled === 1,
      isPublic: current.is_public === 1,
      publicSlug: current.public_slug,
      badgeId: current.badge_id,
      uptimeThresholds: parseThresholds(current.uptime_thresholds),
      notificationServiceIds: currentNotificationIds,
      outageThreshold: current.outage_threshold,
      recoveryThreshold: current.recovery_threshold,
      repeatNotificationMinutes: current.repeat_notification_minutes,
      ...update,
    });
    const mergedNotificationIds = merged.notificationServiceIds ?? [];
    const notificationMembershipChanged = !sameStringSet(
      mergedNotificationIds,
      currentNotificationIds,
    );
    const notificationRulesChanged =
      merged.url !== current.url ||
      merged.enabled !== (current.enabled === 1) ||
      (merged.outageThreshold ?? 3) !== current.outage_threshold ||
      (merged.recoveryThreshold ?? 2) !== current.recovery_threshold ||
      (merged.repeatNotificationMinutes ?? null) !== current.repeat_notification_minutes ||
      !sameStringSet(merged.regionIds, currentRegionIds);
    assertRegionsEnabled(config, merged.regionIds);
    assertPublicHttpUrl(merged.url);
    await assertMonitorSlugAvailable(db, merged.publicSlug ?? null, id);
    await assertNotificationServicesExist(db, mergedNotificationIds);
    await assertBadgeExists(db, merged.badgeId ?? null);
    const timestamp = nowIso(now());
    const thresholds = merged.uptimeThresholds ?? { green: 99.5, lightGreen: 99, orange: 90 };
    const nextCheckAt = update.intervalSeconds
      ? nextBoundary(now(), merged.intervalSeconds).toISOString()
      : null;
    const statements: { sql: string; values: unknown[] }[] = [
      {
        sql: `UPDATE monitors SET name = ?, url = ?, interval_seconds = ?, timeout_ms = ?, enabled = ?,
                dns_diagnostics_enabled = ?, is_public = ?, public_slug = ?, badge_id = ?,
                uptime_thresholds = ?, outage_threshold = ?, recovery_threshold = ?,
                repeat_notification_minutes = ?, next_check_at = COALESCE(?, next_check_at), updated_at = ?
              WHERE id = ?`,
        values: [
          merged.name ?? null,
          merged.url,
          merged.intervalSeconds,
          merged.timeoutMs,
          merged.enabled ? 1 : 0,
          merged.dnsDiagnosticsEnabled ? 1 : 0,
          merged.isPublic ? 1 : 0,
          merged.publicSlug ?? null,
          merged.badgeId ?? null,
          JSON.stringify(thresholds),
          merged.outageThreshold ?? 3,
          merged.recoveryThreshold ?? 2,
          merged.repeatNotificationMinutes ?? null,
          nextCheckAt,
          timestamp,
          id,
        ],
      },
    ];
    if (update.regionIds) {
      statements.push({ sql: 'DELETE FROM monitor_regions WHERE monitor_id = ?', values: [id] });
      for (const regionId of merged.regionIds) {
        statements.push({
          sql: 'INSERT INTO monitor_regions (monitor_id, region_id) VALUES (?, ?)',
          values: [id, regionId],
        });
      }
    }
    if (update.notificationServiceIds) {
      statements.push({
        sql: 'DELETE FROM monitor_notification_services WHERE monitor_id = ?',
        values: [id],
      });
      for (const serviceId of mergedNotificationIds) {
        statements.push({
          sql: 'INSERT INTO monitor_notification_services (monitor_id, notification_service_id) VALUES (?, ?)',
          values: [id, serviceId],
        });
      }
    }
    if (notificationRulesChanged || notificationMembershipChanged) {
      statements.push(
        {
          sql: `UPDATE notification_deliveries SET status = 'cancelled', lease_until = NULL, lease_token = NULL
                WHERE monitor_id = ? AND status IN ('pending', 'sending')`,
          values: [id],
        },
        {
          sql: `UPDATE monitor_notification_state SET config_fingerprint = 'invalidated', updated_at = ? WHERE monitor_id = ?`,
          values: [timestamp, id],
        },
      );
    }
    await batch(db, statements);
    const row = await getMonitor(db, id);
    if (!row) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json({ summary: await monitorSummary(db, row, log) });
  });

  router.add('DELETE', '/api/monitors/:id/history', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const { id } = idSchema.parse(c.params);
    const monitor = await first<{ id: string }>(db, 'SELECT id FROM monitors WHERE id = ?', [id]);
    if (!monitor) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    const timestamp = nowIso(now());
    await batch(db, [
      { sql: 'DELETE FROM network_diagnostics WHERE monitor_id = ?', values: [id] },
      { sql: 'DELETE FROM check_runs WHERE monitor_id = ?', values: [id] },
      { sql: 'DELETE FROM monitor_daily_uptime WHERE monitor_id = ?', values: [id] },
      { sql: 'DELETE FROM notification_deliveries WHERE monitor_id = ?', values: [id] },
      { sql: 'DELETE FROM monitor_notification_state WHERE monitor_id = ?', values: [id] },
      {
        sql: 'UPDATE monitors SET next_check_at = ?, updated_at = ? WHERE id = ?',
        values: [timestamp, timestamp, id],
      },
    ]);
    return noContent();
  });

  router.add('DELETE', '/api/monitors/:id', async (c) => {
    await requireAdmin(c);
    const { id } = idSchema.parse(c.params);
    const result = await run(c.env.db, 'DELETE FROM monitors WHERE id = ?', [id]);
    if (result.meta.changes === 0)
      throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return noContent();
  });

  // Public monitor views -----------------------------------------------------
  router.add('GET', '/api/monitors/public/:id', async (c) => {
    const { db } = c.env;
    const { id } = publicReferenceSchema.parse(c.params);
    const monitor = await getPublicMonitor(db, id);
    if (!monitor) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json({ summary: toPublicMonitorSummary(await monitorSummary(db, monitor, log)) });
  });

  router.add('GET', '/api/monitors/:id/uptime', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const { id } = idSchema.parse(c.params);
    if (!(await getMonitor(db, id)))
      throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json({ uptime: await monitorUptimePayload(db, id, now()) });
  });

  router.add('GET', '/api/monitors/public/:id/uptime', async (c) => {
    const { db } = c.env;
    const { id } = publicReferenceSchema.parse(c.params);
    const monitor = await getPublicMonitor(db, id);
    if (!monitor) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json({ uptime: await monitorUptimePayload(db, monitor.id, now()) });
  });

  router.add('GET', '/api/monitors/:id/latency', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const { id } = idSchema.parse(c.params);
    const { range } = z.object({ range: rangeSchema }).parse(queryObject(c.url));
    if (!(await getMonitor(db, id)))
      throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json(await latencyPayload(db, id, range as RangeKey, now()));
  });

  router.add('GET', '/api/monitors/public/:id/latency', async (c) => {
    const { db } = c.env;
    const { id } = publicReferenceSchema.parse(c.params);
    const { range } = z.object({ range: rangeSchema }).parse(queryObject(c.url));
    const monitor = await getPublicMonitor(db, id);
    if (!monitor) throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    return json(await latencyPayload(db, monitor.id, range as RangeKey, now()));
  });

  router.add('GET', '/api/monitors/:id/observations', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const { id } = idSchema.parse(c.params);
    const query = observationQuerySchema.parse(queryObject(c.url));
    if (!(await getMonitor(db, id)))
      throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const page = await listObservations(db, id, {
      range: query.range as RangeKey,
      ...(query.regionId ? { regionId: query.regionId } : {}),
      cursor,
      limit: query.limit,
      now: now(),
    });
    return json({
      observations: page.observations,
      nextCursor: page.nextCursor ? base64UrlEncodeJson(page.nextCursor) : null,
    });
  });

  router.add('GET', '/api/monitors/:id/dns-diagnostics', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const { id } = idSchema.parse(c.params);
    const query = dnsDiagnosticQuerySchema.parse(queryObject(c.url));
    if (!(await getMonitor(db, id)))
      throw new HttpErrorLike(404, 'not_found', 'Monitor was not found');
    const cursor = query.cursor ? decodeDnsCursor(query.cursor) : null;
    const page = await listDnsDiagnostics(db, id, {
      range: query.range,
      ...(query.regionId ? { regionId: query.regionId } : {}),
      cursor,
      limit: query.limit,
      now: now(),
      parseResult: parseDnsDiagnosticRow,
      log,
    });
    return json({
      diagnostics: page.diagnostics,
      nextCursor: page.nextCursor ? base64UrlEncodeJson(page.nextCursor) : null,
    });
  });

  // ----------------------------------------------------------- status pages --
  router.add('GET', '/api/status-pages', async (c) => {
    await requireAdmin(c);
    return json({ statusPages: await listStatusPageSummaries(c.env.db) });
  });

  router.add('POST', '/api/status-pages', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const input = statusPageSaveSchema.parse(await readJson(c.request));
    await assertStatusPageSlugAvailable(db, input.publicSlug ?? null, null);
    await assertStatusPageMonitorsExist(db, input);
    const id = randomId();
    await batch(db, buildStatusPageStatements(id, input, true, nowIso(now())));
    return json({ statusPage: await getStatusPage(db, id) }, { status: 201 });
  });

  router.add('GET', '/api/status-pages/:id', async (c) => {
    await requireAdmin(c);
    const { id } = idSchema.parse(c.params);
    const statusPage = await getStatusPage(c.env.db, id);
    if (!statusPage) throw new HttpErrorLike(404, 'not_found', 'Status page was not found');
    return json({ statusPage });
  });

  router.add('PUT', '/api/status-pages/:id', async (c) => {
    await requireAdmin(c);
    const { db } = c.env;
    const { id } = idSchema.parse(c.params);
    const input = statusPageSaveSchema.parse(await readJson(c.request));
    if (!(await first<{ id: string }>(db, 'SELECT id FROM status_pages WHERE id = ?', [id]))) {
      throw new HttpErrorLike(404, 'not_found', 'Status page was not found');
    }
    await assertStatusPageSlugAvailable(db, input.publicSlug ?? null, id);
    await assertStatusPageMonitorsExist(db, input);
    await batch(db, buildStatusPageStatements(id, input, false, nowIso(now())));
    return json({ statusPage: await getStatusPage(db, id) });
  });

  router.add('DELETE', '/api/status-pages/:id', async (c) => {
    await requireAdmin(c);
    const { id } = idSchema.parse(c.params);
    const result = await run(c.env.db, 'DELETE FROM status_pages WHERE id = ?', [id]);
    if (result.meta.changes === 0)
      throw new HttpErrorLike(404, 'not_found', 'Status page was not found');
    return noContent();
  });

  router.add('GET', '/api/status-pages/public/:id', async (c) => {
    const { db } = c.env;
    const { id } = publicReferenceSchema.parse(c.params);
    const statusPage = await getPublicStatusPage(db, id);
    if (!statusPage) throw new HttpErrorLike(404, 'not_found', 'Status page was not found');
    return json(await publicStatusPagePayload(db, statusPage, now()));
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function noContent(init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 204, headers });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpErrorLike(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

async function resolveAdmin(
  c: RouteContext<AppEnv>,
  now: () => Date,
): Promise<SessionAdmin | null> {
  const token = parseCookies(c.request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) return null;
  const admin = await lookupSession(c.env.db, c.env.config, token, now());
  if (admin) {
    try {
      await touchSession(c.env.db, c.env.config, token, now());
    } catch {
      // Best-effort bookkeeping only.
    }
  }
  return admin;
}

function serializeSessionCookie(config: ApiConfig, token: string, expires: Date): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${capitalize(config.sessionCookieSameSite)}`,
  ];
  if (config.sessionCookieSecure) parts.push('Secure');
  parts.push(`Expires=${expires.toUTCString()}`, `Max-Age=${config.sessionTtlSeconds}`);
  return parts.join('; ');
}

function clearSessionCookie(config: ApiConfig): string {
  return serializeSessionCookie({ ...config, sessionTtlSeconds: 0 }, '', new Date(0));
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function parseThresholds(raw: string): { green: number; lightGreen: number; orange: number } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      green: Number(parsed.green ?? 99.5),
      lightGreen: Number(parsed.lightGreen ?? 99),
      orange: Number(parsed.orange ?? 90),
    };
  } catch {
    return { green: 99.5, lightGreen: 99, orange: 90 };
  }
}

function assertRegionsEnabled(config: ApiConfig, regionIds: readonly RegionId[]): void {
  const enabled = new Set(config.enabledRegionIds);
  const disabled = regionIds.filter((regionId) => !enabled.has(regionId));
  if (disabled.length > 0) {
    throw new HttpErrorLike(
      400,
      'region_disabled',
      `These regions are not enabled by REGIONS_LIST: ${disabled.join(', ')}`,
    );
  }
}

async function assertMonitorSlugAvailable(
  db: D1Database,
  publicSlug: string | null,
  excludedId: string | null,
): Promise<void> {
  await assertSlugAvailable(db, 'monitors', 'monitor', publicSlug, excludedId);
}

async function assertStatusPageSlugAvailable(
  db: D1Database,
  publicSlug: string | null,
  excludedId: string | null,
): Promise<void> {
  await assertSlugAvailable(db, 'status_pages', 'status page', publicSlug, excludedId);
}

async function assertSlugAvailable(
  db: D1Database,
  table: 'monitors' | 'status_pages',
  resource: 'monitor' | 'status page',
  publicSlug: string | null,
  excludedId: string | null,
): Promise<void> {
  if (!publicSlug) return;
  const conflict = excludedId
    ? await first<{ id: string }>(
        db,
        `SELECT id FROM ${table} WHERE public_slug = ? AND id <> ? LIMIT 1`,
        [publicSlug, excludedId],
      )
    : await first<{ id: string }>(db, `SELECT id FROM ${table} WHERE public_slug = ? LIMIT 1`, [
        publicSlug,
      ]);
  if (conflict) {
    throw new HttpErrorLike(409, 'slug_conflict', `That public ${resource} slug is already in use`);
  }
}

async function assertStatusPageMonitorsExist(db: D1Database, input: StatusPageSave): Promise<void> {
  const uniqueIds = [...new Set(input.groups.flatMap((group) => group.monitorIds))];
  if (uniqueIds.length === 0) return;
  // One query with json_each avoids a D1 round trip per monitor.
  const found = await all<{ id: string }>(
    db,
    'SELECT id FROM monitors WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(uniqueIds)],
  );
  if (found.length !== uniqueIds.length) {
    const existing = new Set(found.map((row) => row.id));
    const missing = uniqueIds.find((id) => !existing.has(id));
    throw new HttpErrorLike(400, 'invalid_monitor', `Monitor ${missing} was not found`);
  }
}

async function assertNotificationServicesExist(
  db: D1Database,
  serviceIds: readonly string[],
): Promise<void> {
  if (!(await notificationServicesExist(db, serviceIds))) {
    throw new HttpErrorLike(
      400,
      'invalid_notification_service',
      'One or more notification services do not exist',
    );
  }
}

async function assertBadgeExists(db: D1Database, badgeId: string | null): Promise<void> {
  if (!badgeId) return;
  if (!(await badgeExists(db, badgeId))) {
    throw new HttpErrorLike(400, 'invalid_badge', 'The selected badge does not exist');
  }
}

function buildStatusPageStatements(
  id: string,
  input: StatusPageSave,
  insertPage: boolean,
  timestamp: string,
): { sql: string; values: unknown[] }[] {
  const statements: { sql: string; values: unknown[] }[] = [];
  if (insertPage) {
    statements.push({
      sql: 'INSERT INTO status_pages (id, title, public_slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      values: [id, input.title, input.publicSlug ?? null, timestamp, timestamp],
    });
  } else {
    statements.push({
      sql: 'UPDATE status_pages SET title = ?, public_slug = ?, updated_at = ? WHERE id = ?',
      values: [input.title, input.publicSlug ?? null, timestamp, id],
    });
    statements.push({
      sql: 'DELETE FROM status_page_groups WHERE status_page_id = ?',
      values: [id],
    });
  }
  for (const [groupPosition, group] of input.groups.entries()) {
    const groupId = randomId();
    statements.push({
      sql: `INSERT INTO status_page_groups (id, status_page_id, title, position, width, show_badges)
            VALUES (?, ?, ?, ?, ?, ?)`,
      values: [groupId, id, group.title, groupPosition, group.width, group.showBadges ? 1 : 0],
    });
    for (const [monitorPosition, monitorId] of group.monitorIds.entries()) {
      statements.push({
        sql: `INSERT INTO status_page_monitors (status_page_id, group_id, monitor_id, position)
              VALUES (?, ?, ?, ?)`,
        values: [id, groupId, monitorId, monitorPosition],
      });
    }
  }
  return statements;
}

function decodeCursor(value: string): { startedAt: string; id: string } {
  try {
    return cursorObjectSchema.parse(base64UrlDecodeJson(value));
  } catch {
    throw invalidCursor();
  }
}

function decodeDnsCursor(value: string): { requestedAt: string; id: string } {
  try {
    return dnsCursorObjectSchema.parse(base64UrlDecodeJson(value));
  } catch {
    throw invalidCursor();
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
