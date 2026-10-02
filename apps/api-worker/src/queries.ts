import { all, first, type D1Database } from '@uptime/cloudflare';
import {
  endpointEvidenceSchema,
  summarizeUptimeDays,
  uptimeWindow,
  type Badge,
  type Monitor,
  type MonitorSummary,
  type Observation,
  type MonitorUptimeData,
  type StatusPageReportSnapshot,
  type StatusPageReportSnapshotMonitor,
  type RegionId,
} from '@uptime/contracts';
import { regions as regionDefinitions } from '@uptime/regions';

import { decodeStoredJson, type StoredJsonLog } from './stored-json.js';
import { deriveAggregateStatus } from './status.js';
import { calculateLatency, ranges, type RangeKey, type LatencyObservationRow } from './latency.js';
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

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function nextBoundary(now: Date, intervalSeconds: number): Date {
  const interval = intervalSeconds * 1_000;
  return new Date((Math.floor(now.getTime() / interval) + 1) * interval);
}

export { uptimeWindow } from '@uptime/contracts';

export const monitorSelect = `
  SELECT m.*, COALESCE((
    SELECT json_group_array(notification_service_id)
    FROM (
      SELECT notification_service_id FROM monitor_notification_services
      WHERE monitor_id = m.id ORDER BY notification_service_id
    )
  ), '[]') AS notification_service_ids
  FROM monitors m`;

export async function getMonitor(db: D1Database, id: string): Promise<MonitorRow | null> {
  return first<MonitorRow>(db, `${monitorSelect} WHERE m.id = ? LIMIT 1`, [id]);
}

export async function getMonitorRegions(db: D1Database, monitorId: string): Promise<RegionId[]> {
  const rows = await all<{ region_id: RegionId }>(
    db,
    'SELECT region_id FROM monitor_regions WHERE monitor_id = ? ORDER BY region_id',
    [monitorId],
  );
  return rows.map((row) => row.region_id);
}

export async function getPublicMonitor(
  db: D1Database,
  reference: string,
): Promise<MonitorRow | null> {
  return first<MonitorRow>(
    db,
    `${monitorSelect}
     WHERE (m.id = ? OR m.public_slug = ?)
       AND (m.is_public = 1 OR EXISTS (
         SELECT 1 FROM status_page_monitors spm WHERE spm.monitor_id = m.id
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
  db: D1Database,
  row: MonitorRow,
  log: StoredJsonLog,
): Promise<MonitorSummary> {
  return (await monitorSummaries(db, [row], log))[0]!;
}

export async function monitorSummaries(
  db: D1Database,
  rows: readonly MonitorRow[],
  log: StoredJsonLog,
): Promise<MonitorSummary[]> {
  if (rows.length === 0) return [];
  const idsJson = JSON.stringify([...new Set(rows.map((row) => row.id))]);
  const [regionRows, badges, latestRows] = await Promise.all([
    all<{ monitor_id: string; region_id: RegionId }>(
      db,
      `SELECT monitor_id, region_id FROM monitor_regions
       WHERE monitor_id IN (SELECT value FROM json_each(?)) ORDER BY monitor_id, region_id`,
      [idsJson],
    ),
    all<Badge>(
      db,
      `SELECT id, name, color FROM badges
       WHERE id IN (SELECT badge_id FROM monitors
         WHERE id IN (SELECT value FROM json_each(?)) AND badge_id IS NOT NULL)`,
      [idsJson],
    ),
    all<ObservationRow>(
      db,
      `WITH requested(id) AS (SELECT value FROM json_each(?)),
       latest_runs AS (
         SELECT m.id AS monitor_id, (
           SELECT cr.id FROM check_runs cr
           WHERE cr.monitor_id = m.id AND cr.status IN ('complete', 'partial')
             AND cr.window_started_at >= m.updated_at
           ORDER BY cr.window_started_at DESC LIMIT 1
         ) AS run_id
         FROM monitors m JOIN requested ON requested.id = m.id
       )
       SELECT o.* FROM latest_runs lr JOIN observations o ON o.check_run_id = lr.run_id`,
      [idsJson],
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
    latestRows.map((row) => ({
      regionId: row.region_id,
      status: row.status,
      success: asBool(row.success),
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

export async function getStatusPage(db: D1Database, id: string) {
  const page = await first<StatusPageRow>(
    db,
    'SELECT id, title, public_slug, created_at, updated_at FROM status_pages WHERE id = ? LIMIT 1',
    [id],
  );
  if (!page) return null;
  const groups = await all<StatusPageGroupRow>(
    db,
    'SELECT id, title, position, width, show_badges FROM status_page_groups WHERE status_page_id = ? ORDER BY position',
    [id],
  );
  const monitors = await all<StatusPageMonitorRow>(
    db,
    `SELECT spm.group_id, m.id, m.name, m.url, m.public_slug,
       b.id AS badge_id, b.name AS badge_name, b.color AS badge_color,
       m.uptime_thresholds, spm.position
     FROM status_page_monitors spm
     JOIN monitors m ON m.id = spm.monitor_id
     LEFT JOIN badges b ON b.id = m.badge_id
     WHERE spm.status_page_id = ?
     ORDER BY spm.position`,
    [id],
  );
  return {
    id: page.id,
    title: page.title,
    publicSlug: page.public_slug,
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

export async function getPublicStatusPage(db: D1Database, reference: string) {
  const byId = await getStatusPage(db, reference);
  if (byId) return byId;
  const matched = await first<{ id: string }>(
    db,
    'SELECT id FROM status_pages WHERE public_slug = ? LIMIT 1',
    [reference],
  );
  return matched ? getStatusPage(db, matched.id) : null;
}

export async function listStatusPageSummaries(db: D1Database) {
  const pages = await all<StatusPageRow>(
    db,
    `SELECT sp.id, sp.title, sp.public_slug, sp.created_at, sp.updated_at,
       (SELECT count(*) FROM status_page_monitors spm WHERE spm.status_page_id = sp.id) AS monitor_count
     FROM status_pages sp ORDER BY sp.created_at DESC`,
  );
  return pages.map((page) => ({
    id: page.id,
    title: page.title,
    publicSlug: page.public_slug,
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
  db: D1Database,
  missing: readonly { monitorId: string; day: string }[],
): Promise<Map<string, ObservedDayRow>> {
  if (missing.length === 0) return new Map();
  const rows = await all<ObservedDayRow & { monitor_id: string }>(
    db,
    `WITH missing(monitor_id, day) AS (
       SELECT json_extract(value, '$.monitorId'), json_extract(value, '$.day') FROM json_each(?)
     )
     SELECT missing.monitor_id, missing.day AS day, COUNT(*) AS received_count,
       SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) AS success_count,
       AVG(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN o.response_ms END) AS average_response_ms
     FROM missing
     CROSS JOIN check_runs cr INDEXED BY check_runs_monitor_time_idx
       ON cr.monitor_id = missing.monitor_id
       AND cr.window_started_at >= missing.day || 'T00:00:00.000Z'
       AND cr.window_started_at < strftime('%Y-%m-%dT00:00:00.000Z', missing.day, '+1 day')
       AND cr.status IN ('complete', 'partial')
     JOIN observations o ON o.check_run_id = cr.id
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
  db: D1Database,
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
  const failing = await all<{
    monitor_id: string;
    region_id: RegionId;
    failure_window: string;
  }>(
    db,
    `WITH requested(monitor_id) AS (SELECT value FROM json_each(?)),
     regions(region_id) AS (SELECT value FROM json_each(?)),
     failures AS (
       SELECT requested.monitor_id, regions.region_id, (
         SELECT o.scheduled_window FROM observations o
         WHERE o.monitor_id = requested.monitor_id AND o.region_id = regions.region_id
           AND o.scheduled_window >= ? AND o.success = 0
           AND EXISTS (SELECT 1 FROM check_runs cr
             WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
         ORDER BY o.scheduled_window DESC LIMIT 1
       ) AS failure_window
       FROM requested CROSS JOIN regions
     )
     SELECT monitor_id, region_id, failure_window
     FROM failures
     WHERE failure_window IS NOT NULL`,
    [
      JSON.stringify(monitorIds),
      JSON.stringify(regionDefinitions.map((region) => region.id)),
      todayIso,
    ],
  );
  if (failing.length === 0) return result;
  const recentRows = await all<{ monitor_id: string; region_id: RegionId; recent: string }>(
    db,
    `WITH failing(monitor_id, region_id, failure_window) AS (
       SELECT json_extract(value, '$.monitor_id'), json_extract(value, '$.region_id'),
         json_extract(value, '$.failure_window')
       FROM json_each(?)
     )
     SELECT failing.monitor_id, failing.region_id, (
       SELECT json_group_array(success) FROM (
         SELECT o.success FROM observations o
         WHERE o.monitor_id = failing.monitor_id AND o.region_id = failing.region_id
           AND o.scheduled_window > failing.failure_window
           AND EXISTS (SELECT 1 FROM check_runs cr
             WHERE cr.id = o.check_run_id AND cr.status IN ('complete', 'partial'))
         ORDER BY o.scheduled_window DESC LIMIT 5
       )
     ) AS recent FROM failing`,
    [JSON.stringify(failing)],
  );
  for (const row of recentRows) {
    const recent = JSON.parse(row.recent) as number[];
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
  db: D1Database,
  monitorId: string,
  currentTime: Date,
): Promise<MonitorUptimePayload> {
  return (await monitorUptimeDetails(db, monitorId, currentTime)).uptime;
}

async function monitorUptimeDetails(
  db: D1Database,
  monitorId: string,
  currentTime: Date,
): Promise<{
  uptime: MonitorUptimePayload;
  affectedRegionIds: RegionId[];
}> {
  return (await monitorUptimeDetailsBulk(db, [monitorId], currentTime)).get(monitorId)!;
}

export async function monitorUptimeDetailsBulk(
  db: D1Database,
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
  db: D1Database,
  monitorIds: readonly string[],
  currentTime: Date,
  closedDaysCache?: ReportUptimeClosedDaysCache,
): Promise<MonitorUptimeDetailsBulkResult> {
  return monitorUptimeDetailsBulkInternal(db, monitorIds, currentTime, closedDaysCache, true);
}

async function monitorUptimeDetailsBulkInternal(
  db: D1Database,
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
    ? await first<{ revision: number }>(
        db,
        `SELECT revision FROM report_cache_revisions WHERE cache_key = 'monitor_daily_uptime' LIMIT 1`,
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
    : await all<UptimeDayRow>(
        db,
        `SELECT monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count
         FROM monitor_daily_uptime
         WHERE monitor_id IN (SELECT value FROM json_each(?)) AND day >= ? AND day <= ?`,
        [
          JSON.stringify(monitorIds),
          rollover ? throughDay : closedDayKeys[0]!,
          cacheEnabled ? throughDay : todayKey,
        ],
      );
  const todayRows = cacheEnabled
    ? await all<UptimeDayRow>(
        db,
        `SELECT monitor_id, day, uptime_percentage, average_response_ms, weight, received_count, success_count
         FROM monitor_daily_uptime
         WHERE monitor_id IN (SELECT value FROM json_each(?)) AND day = ?`,
        [JSON.stringify(monitorIds), todayKey],
      )
    : [];
  const storedRows = [...closedRows, ...todayRows];
  const storedByMonitor = new Map<string, Map<string, UptimeDayRow>>();
  for (const row of storedRows) {
    const values = storedByMonitor.get(row.monitor_id) ?? new Map<string, UptimeDayRow>();
    values.set(row.day.slice(0, 10), row);
    storedByMonitor.set(row.monitor_id, values);
  }
  // D1 triggers maintain this exact aggregate for both finalized rounds and
  // late observations, including the live UTC day. Legacy/imported databases
  // can still have gaps, so seek only those individual UTC days instead of
  // scanning the whole ninety-day observation range.
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
  db: D1Database,
  statusPage: NonNullable<Awaited<ReturnType<typeof getStatusPage>>>,
  currentTime: Date,
): Promise<PublicStatusPagePayload> {
  const monitorIds = [
    ...new Set(statusPage.groups.flatMap((group) => group.monitors.map((monitor) => monitor.id))),
  ];
  const [detailsByMonitor, monitorRows] = await Promise.all([
    monitorUptimeDetailsBulk(db, monitorIds, currentTime),
    all<MonitorRow>(db, `${monitorSelect} WHERE m.id IN (SELECT value FROM json_each(?))`, [
      JSON.stringify(monitorIds),
    ]),
  ]);
  const summaries = await monitorSummaries(db, monitorRows, noopLog);
  const summaryByMonitor = new Map(summaries.map((summary) => [summary.monitor.id, summary]));
  return {
    statusPage: {
      id: statusPage.id,
      title: statusPage.title,
      publicSlug: statusPage.publicSlug,
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
 *
 * LIMITATION: SQLite/D1 has no `percentile_disc`/`date_bin`, so exact samples
 * for the requested range are read and bucketed in the Worker. Queries are
 * bounded by the fixed 1h/24h/7d/30d ranges; monitor-wide ranges on very busy
 * monitors should be watched against D1 row-read limits.
 */
export async function latencyPayload(
  db: D1Database,
  monitorId: string,
  range: RangeKey,
  currentTime: Date,
) {
  const since = new Date(currentTime.getTime() - ranges[range]).toISOString();
  const rows = await all<LatencyObservationRow>(
    db,
    `SELECT region_id, success, started_at, id,
       COALESCE(response_ms, CASE WHEN error_code = 'timeout' THEN total_ms END) AS value
     FROM observations WHERE monitor_id = ? AND started_at >= ?`,
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
  db: D1Database,
  monitorId: string,
  options: {
    range: RangeKey;
    regionId?: RegionId;
    cursor?: Cursor | null;
    limit: number;
    now: Date;
  },
): Promise<{ observations: Observation[]; nextCursor: Cursor | null }> {
  const since = new Date(options.now.getTime() - ranges[options.range]).toISOString();
  const clauses = ['monitor_id = ?', 'started_at >= ?'];
  const values: unknown[] = [monitorId, since];
  if (options.regionId) {
    clauses.push('region_id = ?');
    values.push(options.regionId);
  }
  if (options.cursor) {
    clauses.push('(started_at < ? OR (started_at = ? AND id < ?))');
    values.push(options.cursor.startedAt, options.cursor.startedAt, options.cursor.id);
  }
  const rows = await all<ObservationRow>(
    db,
    `SELECT * FROM observations WHERE ${clauses.join(' AND ')}
     ORDER BY started_at DESC, id DESC LIMIT ?`,
    [...values, options.limit + 1],
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
  db: D1Database,
  monitorId: string,
  options: {
    range: '7d' | '30d';
    regionId?: RegionId;
    cursor?: { requestedAt: string; id: string } | null;
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
  const clauses = ['monitor_id = ?', 'requested_at >= ?'];
  const values: unknown[] = [monitorId, since];
  if (options.regionId) {
    clauses.push('region_id = ?');
    values.push(options.regionId);
  }
  if (options.cursor) {
    clauses.push('(requested_at < ? OR (requested_at = ? AND id < ?))');
    values.push(options.cursor.requestedAt, options.cursor.requestedAt, options.cursor.id);
  }
  const rows = await all<DnsDiagnosticRow>(
    db,
    `SELECT * FROM network_diagnostics WHERE ${clauses.join(' AND ')}
     ORDER BY requested_at DESC, id DESC LIMIT ?`,
    [...values, options.limit + 1],
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

export async function badgeExists(db: D1Database, badgeId: string): Promise<boolean> {
  const row = await first<{ id: string }>(db, 'SELECT id FROM badges WHERE id = ? LIMIT 1', [
    badgeId,
  ]);
  return row !== null;
}

export async function notificationServicesExist(
  db: D1Database,
  serviceIds: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return true;
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM notification_services WHERE id IN (${placeholders(unique.length)})`,
    unique,
  );
  return rows.length === unique.length;
}

export type { BadgeRow };
