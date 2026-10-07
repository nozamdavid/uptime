import {
  type RegionId,
  type Badge,
  type Monitor,
  type MonitorSummary,
  type Observation,
  type MonitorUptimeData,
  type StatusPageReportSnapshot,
  type StatusPageReportSnapshotMonitor,
  endpointEvidenceSchema,
  summarizeUptimeDays,
  uptimeWindow,
} from '@uptime/contracts';
import {
  type Database,
  pgAll,
  pgFirst,
  pgRun,
} from '@uptime/cloudflare/postgres';
import { regions as regionDefinitions } from '@uptime/regions';

import { decodeStoredJson, type StoredJsonLog } from './stored-json.js';
import { deriveAggregateStatus } from './status.js';
import {
  ranges,
  type RangeKey,
  type LatencyAggregateBucket,
  type LatencyObservationRow,
  calculateLatency,
  createLatencyAccumulator,
} from './latency.js';
export {
  calculateLatency,
  createLatencyAccumulator,
  ranges,
  type RangeKey,
  type LatencyAggregateBucket,
  type LatencyObservationRow,
} from './latency.js';
import {
  asBool,
  asNumberOrNull,
  parseBadgeColumns,
  parseNotificationServiceIds,
  parseUptimeThresholds,
  type BadgeRow,
  type DnsDiagnosticRow,
  type MonitorRow,
  type ObservationRow,
  type StatusPageGroupRow,
  type StatusPageMonitorRow,
  type StatusPageRow,
  type UptimeDayRow,
} from './types.js';
import { base64UrlDecodeJson, base64UrlEncodeJson } from './stored-json.js';

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function nextBoundary(now: Date, intervalSeconds: number): Date {
  const interval = intervalSeconds * 1_000;
  return new Date((Math.floor(now.getTime() / interval) + 1) * interval);
}

export { uptimeWindow } from '@uptime/contracts';

export function monitorSelect(db?: Database): string {
  const monitors = db ? db.table('monitors') : '"monitors"';
  const services = db ? db.table('monitor_notification_services') : '"monitor_notification_services"';
  return `SELECT m.*, COALESCE((
    SELECT json_agg(notification_service_id ORDER BY notification_service_id)::text
    FROM ${services}
    WHERE monitor_id = m.id
  ), '[]') AS notification_service_ids
  FROM ${monitors} m`;
}
monitorSelect.toString = () => monitorSelect();

export async function getMonitor(db: Database, id: string): Promise<MonitorRow | null> {
  return pgFirst<MonitorRow>(db, `${monitorSelect(db)} WHERE m.id = $1 LIMIT 1`, [id]);
}

export async function getMonitorRegions(db: Database, monitorId: string): Promise<RegionId[]> {
  const rows = await pgAll<{ region_id: RegionId }>(
    db,
    `SELECT region_id FROM ${db.table('monitor_regions')} WHERE monitor_id = $1 ORDER BY region_id`,
    [monitorId],
  );
  return rows.map((row) => row.region_id);
}

export async function getPublicMonitor(
  db: Database,
  reference: string,
): Promise<MonitorRow | null> {
  return pgFirst<MonitorRow>(
    db,
    `${monitorSelect(db)}
     WHERE (m.id = $1 OR m.public_slug = $2)
       AND (m.is_public = 1 OR EXISTS (
         SELECT 1 FROM ${db.table('status_page_monitors')} spm WHERE spm.monitor_id = m.id
       ))
     LIMIT 1`,
    [reference, reference],
  );
}

function serializeObservation(row: ObservationRow, log: StoredJsonLog): Observation {
  const evidence = parseStoredEndpointEvidence(row.endpoint_evidence, row.id, row.final_url, log);
  return {
    id: row.id,
    checkRunId: row.check_run_id,
    monitorId: row.monitor_id,
    regionId: row.region_id,
    status: row.status,
    success: asBool(row.success),
    httpStatus: row.http_status,
    responseMs: asNumberOrNull(row.response_ms),
    totalMs: asNumberOrNull(row.total_ms),
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    placement: row.placement,
    colo: row.colo,
    finalUrl: row.final_url,
    endpointEvidence: evidence,
    dnsDiagnostic: null,
    redirectCount: row.redirect_count,
    bodyBytes: row.body_bytes,
    probeVersion: row.probe_version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseStoredEndpointEvidence(
  value: unknown,
  observationId: string,
  finalUrl: string | null,
  log: StoredJsonLog,
) {
  if (value === null || value === undefined) return null;
  const decoded = decodeStoredJson(value);
  const parsed = decoded.ok ? endpointEvidenceSchema.safeParse(decoded.value) : null;
  if (parsed?.success) {
    if (finalUrl) {
      try {
        if (new URL(finalUrl).hostname.toLowerCase() === parsed.data.finalHostname)
          return parsed.data;
      } catch {
        return null;
      }
    }
    return null;
  }
  log.warn(
    { event: 'invalid_legacy_endpoint_evidence', observationId },
    'Ignoring invalid stored endpoint evidence',
  );
  return null;
}

export async function monitorSummary(
  db: Database,
  row: MonitorRow,
  log: StoredJsonLog,
): Promise<MonitorSummary> {
  return (await monitorSummaries(db, [row], log))[0]!;
}

export async function monitorSummaries(
  db: Database,
  rows: readonly MonitorRow[],
  log: StoredJsonLog,
): Promise<MonitorSummary[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((row) => row.id))];
  const [regionRows, badges, latestRows] = await Promise.all([
    pgAll<{ monitor_id: string; region_id: RegionId }>(
      db,
      `SELECT monitor_id, region_id FROM ${db.table('monitor_regions')}
       WHERE monitor_id = ANY($1::text[]) ORDER BY monitor_id, region_id`,
      [ids],
    ),
    pgAll<Badge>(
      db,
      `SELECT id, name, color FROM ${db.table('badges')}
       WHERE id IN (
         SELECT badge_id FROM ${db.table('monitors')}
         WHERE id = ANY($1::text[]) AND badge_id IS NOT NULL
       )`,
      [ids],
    ),
    pgAll<ObservationRow>(
      db,
      `WITH latest_runs AS (
         SELECT m.id AS monitor_id, (
           SELECT cr.id FROM ${db.table('check_runs')} cr
           WHERE cr.monitor_id = m.id AND cr.status IN ('complete', 'partial')
             AND cr.window_started_at >= m.updated_at
           ORDER BY cr.window_started_at DESC LIMIT 1
         ) AS run_id
         FROM ${db.table('monitors')} m
         WHERE m.id = ANY($1::text[])
       )
       SELECT o.* FROM latest_runs lr JOIN ${db.table('observations')} o ON o.check_run_id = lr.run_id`,
      [ids],
    ),
  ]);
  const regions = new Map<string, RegionId[]>();
  for (const region of regionRows) {
    const values = regions.get(region.monitor_id) ?? [];
    values.push(region.region_id);
    regions.set(region.monitor_id, values);
  }
  const badgesById = new Map(badges.map((badge) => [badge.id, badge]));
  const latestByMonitor = new Map<string, ObservationRow[]>();
  for (const observation of latestRows) {
    const values = latestByMonitor.get(observation.monitor_id) ?? [];
    values.push(observation);
    latestByMonitor.set(observation.monitor_id, values);
  }
  return rows.map((row) =>
    buildMonitorSummary(
      row,
      regions.get(row.id) ?? [],
      row.badge_id ? (badgesById.get(row.badge_id) ?? null) : null,
      latestByMonitor.get(row.id) ?? [],
      log,
    ),
  );
}

function buildMonitorSummary(
  row: MonitorRow,
  regionIds: RegionId[],
  badge: Badge | null,
  latestRows: ObservationRow[],
  log: StoredJsonLog,
): MonitorSummary {
  const notificationServiceIds = parseNotificationServiceIds(row.notification_service_ids);
  const latestByRegion = Object.fromEntries(
    regionIds.map((id) => [id, null]),
  ) as MonitorSummary['latestByRegion'];
  for (const observation of latestRows) {
    latestByRegion[observation.region_id] = serializeObservation(observation, log);
  }
  const monitor: Monitor = {
    id: row.id,
    name: row.name,
    url: row.url,
    regionIds,
    intervalSeconds: row.interval_seconds as Monitor['intervalSeconds'],
    timeoutMs: row.timeout_ms,
    enabled: asBool(row.enabled),
    dnsDiagnosticsEnabled: asBool(row.dns_diagnostics_enabled),
    isPublic: asBool(row.is_public),
    publicSlug: row.public_slug,
    badge,
    uptimeThresholds: parseUptimeThresholds(row.uptime_thresholds),
    notificationServiceIds,
    outageThreshold: row.outage_threshold,
    recoveryThreshold: row.recovery_threshold,
    repeatNotificationMinutes: row.repeat_notification_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const status = deriveAggregateStatus(
    regionIds,
    latestRows.map((obs) => ({
      regionId: obs.region_id,
      status: obs.status,
      success: asBool(obs.success),
    })),
  );
  return {
    monitor,
    status,
    latestByRegion,
    targetChecksPerDay: regionIds.length * (86_400 / monitor.intervalSeconds),
  } as MonitorSummary;
}

export { toPublicMonitorSummary } from '@uptime/contracts';

// ---------------------------------------------------------------------------
// Status pages
// ---------------------------------------------------------------------------

export async function getStatusPage(db: Database, id: string) {
  const page = await pgFirst<StatusPageRow>(
    db,
    `SELECT id, title, public_slug, font_family, created_at, updated_at FROM ${db.table('status_pages')} WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!page) return null;
  const groups = await pgAll<StatusPageGroupRow>(
    db,
    `SELECT id, title, position, width, show_badges FROM ${db.table('status_page_groups')} WHERE status_page_id = $1 ORDER BY position`,
    [id],
  );
  const monitors = await pgAll<StatusPageMonitorRow>(
    db,
    `SELECT spm.group_id, m.id, m.name, m.url, m.public_slug,
       b.id AS badge_id, b.name AS badge_name, b.color AS badge_color,
       m.uptime_thresholds, spm.position
     FROM ${db.table('status_page_monitors')} spm
     JOIN ${db.table('monitors')} m ON m.id = spm.monitor_id
     LEFT JOIN ${db.table('badges')} b ON b.id = m.badge_id
     WHERE spm.status_page_id = $1
     ORDER BY spm.position`,
    [id],
  );
  return {
    id: page.id,
    title: page.title,
    publicSlug: page.public_slug,
    fontFamily: page.font_family,
    createdAt: page.created_at,
    updatedAt: page.updated_at,
    monitorCount: monitors.length,
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
      position: group.position,
      width: group.width ?? 'full',
      showBadges: asBool(group.show_badges),
      monitors: monitors
        .filter((monitor) => monitor.group_id === group.id)
        .map((monitor) => ({
          id: monitor.id,
          name: monitor.name,
          url: monitor.url,
          publicSlug: monitor.public_slug,
          badge: parseBadgeColumns(monitor),
          uptimeThresholds: parseUptimeThresholds(monitor.uptime_thresholds),
          position: monitor.position,
        })),
    })),
  };
}

export async function getPublicStatusPage(db: Database, reference: string) {
  const byId = await getStatusPage(db, reference);
  if (byId) return byId;
  const matched = await pgFirst<{ id: string }>(
    db,
    `SELECT id FROM ${db.table('status_pages')} WHERE public_slug = $1 LIMIT 1`,
    [reference],
  );
  return matched ? getStatusPage(db, matched.id) : null;
}

export async function listStatusPageSummaries(db: Database) {
  const pages = await pgAll<StatusPageRow>(
    db,
    `SELECT sp.id, sp.title, sp.public_slug, sp.font_family, sp.created_at, sp.updated_at,
       (SELECT count(*)::integer FROM ${db.table('status_page_monitors')} spm WHERE spm.status_page_id = sp.id) AS monitor_count
     FROM ${db.table('status_pages')} sp ORDER BY sp.created_at DESC`,
  );
  return pages.map((page) => ({
    id: page.id,
    title: page.title,
    publicSlug: page.public_slug,
    fontFamily: page.font_family,
    monitorCount: Number(page.monitor_count ?? 0),
    createdAt: page.created_at,
    updatedAt: page.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Uptime
// ---------------------------------------------------------------------------

export type MonitorUptimePayload = MonitorUptimeData &
  Required<Pick<MonitorUptimeData, 'recoveryStatus'>>;

interface ObservedDayRow {
  day: string;
  received_count: number;
  success_count: number;
  average_response_ms: number | null;
}

export interface ReportUptimeClosedDay {
  uptimePercentage: number | null;
  averageResponseMs: number | null;
  weight: number;
}

export interface ReportUptimeClosedDaysCache {
  readonly schemaVersion: '1';
  /** Last closed UTC day represented by every dense per-monitor array. */
  readonly throughDay: string;
  readonly revision: number;
  readonly monitorIds: string[];
  /** Oldest to newest; null records that the day had no observations. */
  readonly days: Record<string, Array<ReportUptimeClosedDay | null>>;
}

export interface MonitorUptimeDetailsBulkResult {
  readonly details: Map<string, { uptime: MonitorUptimePayload; affectedRegionIds: RegionId[] }>;
  /** Present only when the caller must replace its persisted closed-day cache. */
  readonly closedDaysCache?: ReportUptimeClosedDaysCache;
}

function validClosedDaysCache(
  value: ReportUptimeClosedDaysCache | undefined,
  monitorIds: readonly string[],
): value is ReportUptimeClosedDaysCache {
  if (!value || typeof value !== 'object' || value.schemaVersion !== '1') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.throughDay) || !Number.isSafeInteger(value.revision))
    return false;
  if (!Array.isArray(value.monitorIds) || value.monitorIds.length !== monitorIds.length)
    return false;
  if (!value.monitorIds.every((id, index) => id === monitorIds[index])) return false;
  if (!value.days || typeof value.days !== 'object') return false;
  return monitorIds.every((monitorId) => {
    const days = value.days[monitorId];
    return (
      Array.isArray(days) &&
      days.length === 89 &&
      days.every(
        (day) =>
          day === null ||
          (typeof day === 'object' &&
            (day.uptimePercentage === null || Number.isFinite(day.uptimePercentage)) &&
            (day.averageResponseMs === null || Number.isFinite(day.averageResponseMs)) &&
            Number.isFinite(day.weight) &&
            day.weight > 0),
      )
    );
  });
}

async function observedMissingDays(
  db: Database,
  missing: readonly { monitorId: string; day: string }[],
): Promise<Map<string, ObservedDayRow>> {
  if (missing.length === 0) return new Map();
  const rows = await pgAll<ObservedDayRow & { monitor_id: string }>(
    db,
    `WITH missing AS (
       SELECT (elem->>'monitorId')::text AS monitor_id, (elem->>'day')::text AS day
       FROM json_array_elements($1::json) AS elem
     )
     SELECT missing.monitor_id, missing.day AS day,
       COUNT(*)::integer AS received_count,
       COALESCE(SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END), 0)::integer AS success_count,
       AVG(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN o.response_ms END)::double precision AS average_response_ms
     FROM missing
     JOIN ${db.table('check_runs')} cr
       ON cr.monitor_id = missing.monitor_id
       AND cr.window_started_at >= missing.day || 'T00:00:00.000Z'
       AND cr.window_started_at < (missing.day::date + 1)::text || 'T00:00:00.000Z'
       AND cr.status IN ('complete', 'partial')
     JOIN ${db.table('observations')} o ON o.check_run_id = cr.id
     GROUP BY missing.monitor_id, missing.day`,
    [JSON.stringify(missing)],
  );
  return new Map(rows.map((row) => [`${row.monitor_id}:${row.day}`, row]));
}

function summarizeDays(
  stored: Map<string, UptimeDayRow>,
  observed: Map<string, ObservedDayRow>,
  dayKeys: readonly string[],
): Omit<MonitorUptimePayload, 'recoveryStatus'> {
  return summarizeUptimeDays(dayKeys, (date) => {
    const storedRow = stored.get(date);
    let uptimePercentage: number | null = null;
    let averageResponseMs: number | null = null;
    let weight = 0;
    if (storedRow) {
      uptimePercentage =
        storedRow.uptime_percentage === null ? null : Number(storedRow.uptime_percentage);
      averageResponseMs = asNumberOrNull(storedRow.average_response_ms);
      const explicitWeight = Number(storedRow.weight ?? 0);
      const received = Number(storedRow.received_count ?? 0);
      weight = explicitWeight > 0 ? explicitWeight : received > 0 ? received : 1;
    } else {
      const row = observed.get(date);
      if (row) {
        const received = Number(row.received_count);
        const success = Number(row.success_count);
        uptimePercentage = received === 0 ? null : (success / received) * 100;
        averageResponseMs = asNumberOrNull(row.average_response_ms);
        weight = received > 0 ? received : 1;
      }
    }
    return { weight, uptimePercentage, averageResponseMs };
  });
}

async function recoveryStatuses(
  db: Database,
  monitorIds: readonly string[],
  todayIso: string,
): Promise<
  Map<
    string,
    { recoveryStatus: 'up' | 'down' | 'recovering' | null; affectedRegionIds: RegionId[] }
  >
> {
  const result = new Map<
    string,
    { recoveryStatus: 'up' | 'down' | 'recovering' | null; affectedRegionIds: RegionId[] }
  >(monitorIds.map((id) => [id, { recoveryStatus: null, affectedRegionIds: [] }]));
  if (monitorIds.length === 0) return result;
  const failing = await pgAll<{
    monitor_id: string;
    region_id: RegionId;
    failure_window: string;
  }>(
    db,
    `WITH requested AS (
       SELECT unnest($1::text[]) AS monitor_id
     ),
     regions AS (
       SELECT unnest($2::text[]) AS region_id
     ),
     failures AS (
       SELECT requested.monitor_id, regions.region_id, (
         SELECT o.scheduled_window FROM ${db.table('observations')} o
         WHERE o.monitor_id = requested.monitor_id AND o.region_id = regions.region_id
           AND o.scheduled_window >= $3 AND o.success = 0
           AND EXISTS (SELECT 1 FROM ${db.table('check_runs')} cr
             WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
         ORDER BY o.scheduled_window DESC LIMIT 1
       ) AS failure_window
       FROM requested CROSS JOIN regions
     )
     SELECT monitor_id, region_id, failure_window
     FROM failures
     WHERE failure_window IS NOT NULL`,
    [
      monitorIds,
      regionDefinitions.map((region) => region.id),
      todayIso,
    ],
  );
  if (failing.length === 0) return result;
  const recentRows = await pgAll<{ monitor_id: string; region_id: RegionId; recent: unknown }>(
    db,
    `WITH failing AS (
       SELECT (elem->>'monitor_id')::text AS monitor_id,
              (elem->>'region_id')::text AS region_id,
              (elem->>'failure_window')::text AS failure_window
       FROM json_array_elements($1::json) AS elem
     )
     SELECT failing.monitor_id, failing.region_id, (
       SELECT COALESCE(json_agg(sub.success ORDER BY sub.scheduled_window DESC)::text, '[]')
       FROM (
         SELECT o.success, o.scheduled_window FROM ${db.table('observations')} o
         WHERE o.monitor_id = failing.monitor_id AND o.region_id = failing.region_id
           AND o.scheduled_window > failing.failure_window
           AND EXISTS (SELECT 1 FROM ${db.table('check_runs')} cr
             WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
         ORDER BY o.scheduled_window DESC LIMIT 5
       ) sub
     ) AS recent FROM failing`,
    [JSON.stringify(failing)],
  );
  for (const row of recentRows) {
    const recent = (typeof row.recent === 'string' ? JSON.parse(row.recent) : row.recent) as number[];
    const firstTwo = recent.slice(0, 2);
    const state =
      recent.length === 5 && recent.every((success) => success === 1)
        ? 'up'
        : firstTwo.length === 2 && firstTwo.every((success) => success === 1)
          ? 'recovering'
          : 'down';
    const current = result.get(row.monitor_id)!;
    if (state === 'down') {
      current.recoveryStatus = 'down';
      current.affectedRegionIds.push(row.region_id);
    } else if (state === 'recovering' && current.recoveryStatus !== 'down') {
      current.recoveryStatus = 'recovering';
    } else if (state === 'up' && current.recoveryStatus === null) {
      current.recoveryStatus = 'up';
    }
  }
  for (const value of result.values()) {
    if (value.recoveryStatus !== 'down') value.affectedRegionIds = [];
  }
  return result;
}

export async function monitorUptimePayload(
  db: Database,
  monitorId: string,
  currentTime: Date,
): Promise<MonitorUptimePayload> {
  return (await monitorUptimeDetails(db, monitorId, currentTime)).uptime;
}

async function monitorUptimeDetails(
  db: Database,
  monitorId: string,
  currentTime: Date,
): Promise<{
  uptime: MonitorUptimePayload;
  affectedRegionIds: RegionId[];
}> {
  return (await monitorUptimeDetailsBulk(db, [monitorId], currentTime)).get(monitorId)!;
}

export async function monitorUptimeDetailsBulk(
  db: Database,
  monitorIds: readonly string[],
  currentTime: Date,
): Promise<Map<string, { uptime: MonitorUptimePayload; affectedRegionIds: RegionId[] }>> {
  return (await monitorUptimeDetailsBulkInternal(db, monitorIds, currentTime, undefined, false))
    .details;
}

function cacheDay(row: UptimeDayRow | ObservedDayRow | undefined): ReportUptimeClosedDay | null {
  if (!row) return null;
  const received = Number(row.received_count ?? 0);
  const success = Number(row.success_count ?? 0);
  const uptimePercentage =
    'uptime_percentage' in row
      ? row.uptime_percentage === null
        ? null
        : Number(row.uptime_percentage)
      : received === 0
        ? null
        : (success / received) * 100;
  return {
    uptimePercentage,
    averageResponseMs: asNumberOrNull(row.average_response_ms),
    weight:
      'weight' in row && Number(row.weight ?? 0) > 0
        ? Number(row.weight)
        : received > 0
          ? received
          : 1,
  };
}

function cachedStoredRow(day: string, row: ReportUptimeClosedDay): UptimeDayRow {
  return {
    monitor_id: '',
    day,
    uptime_percentage: row.uptimePercentage,
    average_response_ms: row.averageResponseMs,
    weight: row.weight,
    received_count: null,
    success_count: null,
  } as UptimeDayRow;
}

/**
 * Bulk uptime with a versioned cache for the 89 immutable UTC days. Warm calls
 * read only the singleton revision and today's aggregate rows. A rollover
 * rereads yesterday once before promoting it into the closed-day cache.
 */
export async function monitorUptimeDetailsBulkCached(
  db: Database,
  monitorIds: readonly string[],
  currentTime: Date,
  closedDaysCache?: ReportUptimeClosedDaysCache,
): Promise<MonitorUptimeDetailsBulkResult> {
  return monitorUptimeDetailsBulkInternal(db, monitorIds, currentTime, closedDaysCache, true);
}

async function monitorUptimeDetailsBulkInternal(
  db: Database,
  requestedMonitorIds: readonly string[],
  currentTime: Date,
  closedDaysCache: ReportUptimeClosedDaysCache | undefined,
  cacheEnabled: boolean,
): Promise<MonitorUptimeDetailsBulkResult> {
  const monitorIds = [...new Set(requestedMonitorIds)].sort();
  const { today, dayKeys } = uptimeWindow(currentTime);
  const todayKey = today.toISOString().slice(0, 10);
  const closedDayKeys = dayKeys.slice(0, -1);
  const throughDay = closedDayKeys.at(-1)!;
  const revisionRow = cacheEnabled
    ? await pgFirst<{ revision: number }>(
        db,
        `SELECT revision FROM ${db.table('report_cache_revisions')} WHERE cache_key = 'monitor_daily_uptime' LIMIT 1`,
      )
    : null;
  const revision = Number(revisionRow?.revision ?? 0);
  if (!validClosedDaysCache(closedDaysCache, monitorIds)) closedDaysCache = undefined;
  const sameMonitors =
    closedDaysCache?.monitorIds.length === monitorIds.length &&
    closedDaysCache.monitorIds.every((id, index) => id === monitorIds[index]);
  const sameRevision = closedDaysCache?.revision === revision;
  const cacheCurrent =
    closedDaysCache?.schemaVersion === '1' &&
    sameMonitors &&
    sameRevision &&
    closedDaysCache.throughDay === throughDay;
  const priorThrough = new Date(`${throughDay}T00:00:00.000Z`);
  priorThrough.setUTCDate(priorThrough.getUTCDate() - 1);
  const rollover =
    closedDaysCache?.schemaVersion === '1' &&
    sameMonitors &&
    sameRevision &&
    closedDaysCache.throughDay === priorThrough.toISOString().slice(0, 10);
  const closedRows = cacheCurrent
    ? []
    : await pgAll<UptimeDayRow>(
        db,
        `SELECT monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count
         FROM ${db.table('monitor_daily_uptime')}
         WHERE monitor_id = ANY($1::text[]) AND day >= $2 AND day <= $3`,
        [
          monitorIds,
          rollover ? throughDay : closedDayKeys[0]!,
          cacheEnabled ? throughDay : todayKey,
        ],
      );
  const todayRows = cacheEnabled
    ? await pgAll<UptimeDayRow>(
        db,
        `SELECT monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count
         FROM ${db.table('monitor_daily_uptime')}
         WHERE monitor_id = ANY($1::text[]) AND day = $2`,
        [monitorIds, todayKey],
      )
    : [];
  const storedRows = [...closedRows, ...todayRows];
  const storedByMonitor = new Map<string, Map<string, UptimeDayRow>>();
  for (const row of storedRows) {
    const values = storedByMonitor.get(row.monitor_id) ?? new Map<string, UptimeDayRow>();
    values.set(row.day.slice(0, 10), row);
    storedByMonitor.set(row.monitor_id, values);
  }
  const closedBase = new Map<string, Map<string, UptimeDayRow>>();
  if (cacheCurrent || rollover) {
    for (const monitorId of monitorIds) {
      const cached = closedDaysCache!.days[monitorId] ?? [];
      const keys = cacheCurrent ? closedDayKeys : closedDayKeys.slice(0, -1);
      const values = rollover ? cached.slice(-keys.length) : cached;
      const rows = new Map<string, UptimeDayRow>();
      keys.forEach((day, index) => {
        const value = values[index];
        if (value) rows.set(day, cachedStoredRow(day, value));
      });
      closedBase.set(monitorId, rows);
    }
  }
  for (const row of closedRows) {
    const values = closedBase.get(row.monitor_id) ?? new Map<string, UptimeDayRow>();
    values.set(row.day.slice(0, 10), row);
    closedBase.set(row.monitor_id, values);
  }
  const missing = monitorIds.flatMap((monitorId) => {
    const stored = storedByMonitor.get(monitorId) ?? new Map();
    const closed = closedBase.get(monitorId) ?? new Map();
    const candidates = cacheCurrent
      ? [todayKey]
      : [...(rollover ? [throughDay] : closedDayKeys), todayKey];
    return candidates
      .filter((day) => !stored.has(day) && !closed.has(day))
      .map((day) => ({ monitorId, day }));
  });
  const observed = await observedMissingDays(db, missing);
  const recoveries = await recoveryStatuses(db, monitorIds, today.toISOString());
  let nextCache: ReportUptimeClosedDaysCache | undefined;
  if (cacheEnabled && !cacheCurrent) {
    const days: ReportUptimeClosedDaysCache['days'] = {};
    for (const monitorId of monitorIds) {
      const stored = storedByMonitor.get(monitorId) ?? new Map();
      const closed = closedBase.get(monitorId) ?? new Map();
      days[monitorId] = closedDayKeys.map((day) =>
        cacheDay(stored.get(day) ?? closed.get(day) ?? observed.get(`${monitorId}:${day}`)),
      );
    }
    nextCache = { schemaVersion: '1', throughDay, revision, monitorIds: [...monitorIds], days };
  }
  const details = new Map(
    monitorIds.map((monitorId) => {
      const stored = new Map(storedByMonitor.get(monitorId) ?? []);
      for (const [day, row] of closedBase.get(monitorId) ?? []) stored.set(day, row);
      const observedForMonitor = new Map(
        dayKeys.flatMap((day) => {
          const row = observed.get(`${monitorId}:${day}`);
          return row ? [[day, row] as const] : [];
        }),
      );
      const summary = summarizeDays(stored, observedForMonitor, dayKeys);
      const recovery = recoveries.get(monitorId)!;
      return [
        monitorId,
        {
          uptime: { ...summary, recoveryStatus: recovery.recoveryStatus },
          affectedRegionIds: recovery.affectedRegionIds,
        },
      ];
    }),
  );
  return nextCache ? { details, closedDaysCache: nextCache } : { details };
}

export interface PublicStatusPagePayload {
  statusPage: Omit<StatusPageReportSnapshot['statusPage'], 'groups'> & {
    groups: Array<
      Omit<StatusPageReportSnapshot['statusPage']['groups'][number], 'monitors'> & {
        monitors: Array<
          StatusPageReportSnapshotMonitor &
            Required<Pick<StatusPageReportSnapshotMonitor, 'badge' | 'uptimeThresholds'>>
        >;
      }
    >;
  };
}

export async function publicStatusPagePayload(
  db: Database,
  statusPage: NonNullable<Awaited<ReturnType<typeof getStatusPage>>>,
  currentTime: Date,
): Promise<PublicStatusPagePayload> {
  const monitorIds = [
    ...new Set(statusPage.groups.flatMap((group) => group.monitors.map((monitor) => monitor.id))),
  ];
  const [detailsByMonitor, monitorRows] = await Promise.all([
    monitorUptimeDetailsBulk(db, monitorIds, currentTime),
    pgAll<MonitorRow>(db, `${monitorSelect(db)} WHERE m.id = ANY($1::text[])`, [
      monitorIds,
    ]),
  ]);
  const summaries = await monitorSummaries(db, monitorRows, noopLog);
  const summaryByMonitor = new Map(summaries.map((summary) => [summary.monitor.id, summary]));
  return {
    statusPage: {
      id: statusPage.id,
      title: statusPage.title,
      publicSlug: statusPage.publicSlug,
      fontFamily: statusPage.fontFamily,
      groups: statusPage.groups.map((group) => ({
        id: group.id,
        title: group.title,
        width: group.width,
        showBadges: group.showBadges,
        monitors: group.monitors.map((monitor) => {
          const details = detailsByMonitor.get(monitor.id)!;
          const uptime = details.uptime;
          const summary = summaryByMonitor.get(monitor.id);
          return {
            id: monitor.id,
            name: monitor.name,
            url: monitor.url,
            publicSlug: monitor.publicSlug,
            badge: monitor.badge,
            uptimeThresholds: monitor.uptimeThresholds,
            uptimePercentage: uptime.uptimePercentage,
            status:
              summary?.status === 'degraded' ? ('down' as const) : (summary?.status ?? 'unknown'),
            configuredRegionCount: summary?.monitor.regionIds.length ?? 0,
            affectedRegionIds: details.affectedRegionIds,
            recoveryStatus: uptime.recoveryStatus,
            days: uptime.days,
          };
        }),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

/**
 * Build the bounded latency payload for a requested range.
 */
export async function latencyPayload(
  db: Database,
  monitorId: string,
  range: RangeKey,
  currentTime: Date,
) {
  const since = new Date(currentTime.getTime() - ranges[range]).toISOString();
  const rows = await pgAll<LatencyObservationRow>(
    db,
    `SELECT region_id, success, started_at, id,
       COALESCE(response_ms, CASE WHEN error_code = 'timeout' THEN total_ms END) AS value
     FROM ${db.table('observations')} WHERE monitor_id = $1 AND started_at >= $2`,
    [monitorId, since],
  );

  const configuredRegionIds = await getMonitorRegions(db, monitorId);
  return { range, ...calculateLatency(rows, configuredRegionIds, range) };
}

// ---------------------------------------------------------------------------
// History queries
// ---------------------------------------------------------------------------

export interface Cursor {
  startedAt: string;
  id: string;
}

export async function listObservations(
  db: Database,
  monitorId: string,
  options: {
    range: RangeKey;
    regionId?: RegionId | undefined;
    cursor?: Cursor | null | undefined;
    limit: number;
    now: Date;
  },
): Promise<{ observations: Observation[]; nextCursor: Cursor | null }> {
  const since = new Date(options.now.getTime() - ranges[options.range]).toISOString();
  const values: unknown[] = [monitorId, since];
  const clauses = [`monitor_id = $1`, `started_at >= $2`];

  if (options.regionId !== undefined) {
    values.push(options.regionId);
    clauses.push(`region_id = $${values.length}`);
  }
  if (options.cursor) {
    values.push(options.cursor.startedAt);
    const startedAtParam = `$${values.length}`;
    values.push(options.cursor.id);
    const idParam = `$${values.length}`;
    clauses.push(`(started_at < ${startedAtParam} OR (started_at = ${startedAtParam} AND id < ${idParam}))`);
  }
  values.push(options.limit + 1);
  const limitParam = `$${values.length}`;

  const rows = await pgAll<ObservationRow>(
    db,
    `SELECT * FROM ${db.table('observations')} WHERE ${clauses.join(' AND ')}
     ORDER BY started_at DESC, id DESC LIMIT ${limitParam}`,
    values,
  );

  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  return {
    observations: page.map((row) => serializeObservation(row, noopLog)),
    nextCursor:
      hasMore && page.length > 0
        ? { startedAt: page.at(-1)!.started_at, id: page.at(-1)!.id }
        : null,
  };
}

export interface SerializedDnsDiagnostic {
  id: string;
  monitorId: string;
  checkRunId: string | null;
  observationId: string | null;
  regionId: RegionId;
  kind: 'dns_candidates';
  windowStartedAt: string;
  lifecycle: 'pending' | 'complete' | 'unavailable';
  finalHostname: string | null;
  result: unknown;
  failureCode: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export async function listDnsDiagnostics(
  db: Database,
  monitorId: string,
  options: {
    range: '7d' | '30d';
    regionId?: RegionId | undefined;
    cursor?: { requestedAt: string; id: string } | null | undefined;
    limit: number;
    now: Date;
    parseResult: (row: DnsDiagnosticRow, log: StoredJsonLog) => unknown;
    log: StoredJsonLog;
  },
): Promise<{
  diagnostics: SerializedDnsDiagnostic[];
  nextCursor: { requestedAt: string; id: string } | null;
}> {
  const since = new Date(
    options.now.getTime() - (options.range === '30d' ? ranges['30d'] : ranges['7d']),
  ).toISOString();
  const values: unknown[] = [monitorId, since];
  const clauses = [`monitor_id = $1`, `requested_at >= $2`];

  if (options.regionId !== undefined) {
    values.push(options.regionId);
    clauses.push(`region_id = $${values.length}`);
  }
  if (options.cursor) {
    values.push(options.cursor.requestedAt);
    const requestedAtParam = `$${values.length}`;
    values.push(options.cursor.id);
    const idParam = `$${values.length}`;
    clauses.push(`(requested_at < ${requestedAtParam} OR (requested_at = ${requestedAtParam} AND id < ${idParam}))`);
  }
  values.push(options.limit + 1);
  const limitParam = `$${values.length}`;

  const rows = await pgAll<DnsDiagnosticRow>(
    db,
    `SELECT * FROM ${db.table('network_diagnostics')} WHERE ${clauses.join(' AND ')}
     ORDER BY requested_at DESC, id DESC LIMIT ${limitParam}`,
    values,
  );

  const hasMore = rows.length > options.limit;
  const page = rows
    .slice(0, options.limit)
    .map((row) => serializeDnsDiagnostic(row, options.parseResult, options.log));
  return {
    diagnostics: page,
    nextCursor:
      hasMore && page.length > 0
        ? { requestedAt: page.at(-1)!.requestedAt, id: page.at(-1)!.id }
        : null,
  };
}

function serializeDnsDiagnostic(
  row: DnsDiagnosticRow,
  parseResult: (row: DnsDiagnosticRow, log: StoredJsonLog) => unknown,
  log: StoredJsonLog,
): SerializedDnsDiagnostic {
  const parsed = parseResult(row, log);
  const lifecycle = row.lifecycle === 'complete' && parsed === null ? 'unavailable' : row.lifecycle;
  const finalHostname = (parsed as { finalHostname?: string } | null)?.finalHostname ?? null;
  return {
    id: row.id,
    monitorId: row.monitor_id,
    checkRunId: row.check_run_id,
    observationId: row.observation_id,
    regionId: row.region_id,
    kind: row.kind,
    windowStartedAt: row.window_started_at,
    lifecycle,
    finalHostname,
    result: parsed,
    failureCode:
      lifecycle === 'unavailable' && row.lifecycle === 'complete' && parsed === null
        ? 'protocol_invalid_response'
        : row.failure_code,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export const noopLog: StoredJsonLog = { warn: () => undefined };

export async function badgeExists(db: Database, badgeId: string): Promise<boolean> {
  const row = await pgFirst<{ id: string }>(
    db,
    `SELECT id FROM ${db.table('badges')} WHERE id = $1 LIMIT 1`,
    [badgeId],
  );
  return row !== null;
}

export async function notificationServicesExist(
  db: Database,
  serviceIds: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return true;
  const rows = await pgAll<{ id: string }>(
    db,
    `SELECT id FROM ${db.table('notification_services')} WHERE id = ANY($1::text[])`,
    [unique],
  );
  return rows.length === unique.length;
}

export interface NotificationHistoryWrite {
  notificationServiceId: string;
  monitorId: string | null;
  monitorName: string;
  monitorUrl: string | null;
  provider: string;
  kind: string;
  status: 'sent' | 'failed';
  createdAt: Date;
  text: string;
  externalUrl: string | null;
  error: string | null;
  preview: { subject?: string; from?: string; to?: string[]; handle?: string };
}

export async function recordNotificationHistory(
  db: Database,
  entry: NotificationHistoryWrite,
): Promise<void> {
  await pgRun(
    db,
    `INSERT INTO ${db.table('notification_history')} (
       id, notification_service_id, monitor_id, monitor_name, monitor_url,
       provider, kind, status, created_at, text, external_url, error, preview
     )
     SELECT $1, id,
       CASE WHEN $2::text IS NOT NULL AND EXISTS (SELECT 1 FROM ${db.table('monitors')} WHERE id = $2)
         THEN $2 ELSE NULL END,
       $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     FROM ${db.table('notification_services')} WHERE id = $13`,
    [
      crypto.randomUUID(),
      entry.monitorId,
      entry.monitorName,
      entry.monitorUrl,
      entry.provider,
      entry.kind,
      entry.status,
      entry.createdAt.toISOString(),
      entry.text,
      entry.externalUrl,
      entry.error,
      JSON.stringify(entry.preview),
      entry.notificationServiceId,
    ],
  );
}

export type { BadgeRow };
