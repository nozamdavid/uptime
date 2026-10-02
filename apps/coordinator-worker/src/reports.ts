import {
  all,
  first,
  nowIso,
  parseUptimeThresholds,
  toBoolean,
  type D1Database,
  type MonitorDailyUptimeRow,
  type MonitorRow,
} from '@uptime/cloudflare';
import { regionIds as canonicalRegionIds, type RegionId } from '@uptime/regions';
import {
  summarizeUptimeDays,
  uptimeWindow,
  type Badge,
  type MonitorSummary,
  type PublicMonitorSummary,
} from '@uptime/contracts';
import {
  monitorSummaries,
  monitorUptimeDetailsBulkCached,
  toPublicMonitorSummary,
  type ReportUptimeClosedDaysCache,
} from '@uptime/api-worker/queries';

import type { MonitorReportSnapshot, StatusPageReportSnapshot } from './report-types.js';

interface ObservationSummaryRow {
  region_id: RegionId;
  status: string;
  success: number;
  http_status: number | null;
  response_ms: number | null;
  total_ms: number | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ReportBuildOptions {
  readonly now: Date;
  readonly staleAfterSeconds: number;
  /** Shared persisted history for the 89 closed UTC days. */
  readonly closedDaysCache?: ReportUptimeClosedDaysCache;
}

export interface CohortMonitorData {
  readonly summary: PublicMonitorSummary;
  readonly uptime: MonitorReportSnapshot['uptime'];
  readonly latestObservationAt: string | null;
}

export interface ReportCohortData {
  readonly monitors: Map<string, CohortMonitorData>;
  readonly statusPages: Map<string, StatusPageReportSnapshot>;
  /** Present only when the publisher must replace its persisted cache object. */
  readonly closedDaysCache?: ReportUptimeClosedDaysCache;
}

/** UTC day keys for the trailing 90-day window, oldest first. */
export function uptimeDayKeys(now: Date): { dayKeys: string[]; sinceDay: string; today: string } {
  const { today, dayKeys } = uptimeWindow(now);
  return { dayKeys, sinceDay: dayKeys[0]!, today: today.toISOString().slice(0, 10) };
}

function deriveAggregateStatus(
  expectedRegions: readonly RegionId[],
  latest: readonly { region_id: RegionId; success: number }[],
): 'up' | 'degraded' | 'down' | 'unknown' {
  if (expectedRegions.length === 0 || latest.length === 0) return 'unknown';
  const latestByRegion = new Map(latest.map((item) => [item.region_id, item]));
  const expectedResults = expectedRegions.map((regionId) => latestByRegion.get(regionId));
  if (expectedResults.some((item) => item === undefined)) return 'unknown';
  const successes = expectedResults.filter((item) => item?.success === 1).length;
  if (successes === expectedResults.length) return 'up';
  if (successes === 0) return 'down';
  return 'degraded';
}

async function loadBadge(db: D1Database, badgeId: string | null): Promise<Badge | null> {
  if (!badgeId) return null;
  const row = await first<Badge>(db, 'SELECT id, name, color FROM badges WHERE id = ? LIMIT 1', [
    badgeId,
  ]);
  return row;
}

async function buildPublicSummary(
  db: D1Database,
  monitor: MonitorRow,
  regions: readonly RegionId[],
): Promise<PublicMonitorSummary> {
  // The latest finalized round is evidence only after the monitor's last edit.
  const latestRun = await first<{
    id: string;
    window_started_at: string;
    expected_regions: string;
    expected_region_count: number;
  }>(
    db,
    `SELECT id, window_started_at, expected_regions, expected_region_count FROM check_runs
     WHERE monitor_id = ? AND status IN ('complete', 'partial')
     ORDER BY window_started_at DESC LIMIT 1`,
    [monitor.id],
  );
  const latestRows =
    latestRun && Date.parse(latestRun.window_started_at) >= Date.parse(monitor.updated_at)
      ? await all<ObservationSummaryRow>(
          db,
          `SELECT region_id, status, success, http_status, response_ms, total_ms, error_code,
             started_at, completed_at
           FROM observations WHERE check_run_id = ?`,
          [latestRun.id],
        )
      : [];
  const expectedRegions = latestRun
    ? (JSON.parse(latestRun.expected_regions) as RegionId[])
    : regions;

  const latestByRegion: Record<string, unknown> = {};
  for (const regionId of regions) latestByRegion[regionId] = null;
  for (const observation of latestRows) {
    latestByRegion[observation.region_id] = {
      regionId: observation.region_id,
      status: observation.status,
      success: toBoolean(observation.success),
      httpStatus: observation.http_status,
      responseMs: observation.response_ms,
      totalMs: observation.total_ms,
      errorCode: observation.error_code,
      startedAt: observation.started_at,
      completedAt: observation.completed_at,
    };
  }

  return {
    monitor: {
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      regionIds: [...regions],
      intervalSeconds:
        monitor.interval_seconds as PublicMonitorSummary['monitor']['intervalSeconds'],
      timeoutMs: monitor.timeout_ms,
      enabled: toBoolean(monitor.enabled),
      isPublic: toBoolean(monitor.is_public),
      publicSlug: monitor.public_slug,
      badge: await loadBadge(db, monitor.badge_id),
      uptimeThresholds: parseUptimeThresholds(monitor.uptime_thresholds),
      createdAt: monitor.created_at,
      updatedAt: monitor.updated_at,
    },
    status:
      latestRun && expectedRegions.length < latestRun.expected_region_count
        ? 'unknown'
        : deriveAggregateStatus(expectedRegions, latestRows),
    latestByRegion: latestByRegion as PublicMonitorSummary['latestByRegion'],
    targetChecksPerDay: regions.length * (86_400 / monitor.interval_seconds),
  } as PublicMonitorSummary;
}

async function loadUptimeRows(
  db: D1Database,
  monitorId: string,
  sinceDay: string,
): Promise<MonitorDailyUptimeRow[]> {
  return all<MonitorDailyUptimeRow>(
    db,
    `SELECT * FROM monitor_daily_uptime WHERE monitor_id = ? AND day >= ? ORDER BY day ASC`,
    [monitorId, sinceDay],
  );
}

/** Port of the Node `summarizeMonitorUptime` weighted-uptime semantics. */
function summarizeUptime(
  rows: readonly MonitorDailyUptimeRow[],
  dayKeys: readonly string[],
): MonitorReportSnapshot['uptime'] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return summarizeUptimeDays(dayKeys, (date) => {
    const row = byDay.get(date);
    const receivedCount = Number(row?.received_count ?? 0);
    const successCount = Number(row?.success_count ?? 0);
    const explicitPercentage =
      row?.uptime_percentage === null || row?.uptime_percentage === undefined
        ? null
        : Number(row.uptime_percentage);
    const uptimePercentage =
      explicitPercentage ?? (receivedCount === 0 ? null : (successCount / receivedCount) * 100);
    const explicitWeight = Number(row?.weight ?? 0);
    const weight = explicitWeight > 0 ? explicitWeight : receivedCount > 0 ? receivedCount : 1;
    return {
      weight,
      uptimePercentage,
      averageResponseMs:
        row?.average_response_ms === null || row?.average_response_ms === undefined
          ? null
          : Number(row.average_response_ms),
    };
  });
}

interface RecoveryRow {
  state: 'up' | 'recovering' | 'down';
  region_id: RegionId;
}

/**
 * Latest per-region recovery evidence since `sinceIso`. A region that failed
 * today is `up` when its latest five observations all succeeded, `recovering`
 * when the latest two all succeeded, otherwise `down`.
 */
async function loadRegionRecovery(
  db: D1Database,
  monitorId: string,
  sinceIso: string,
): Promise<RecoveryRow[]> {
  const regionValues = canonicalRegionIds.map((regionId) => `('${regionId}')`).join(', ');
  const failedRegions = await all<{ region_id: RegionId }>(
    db,
    `WITH candidate_regions(region_id) AS (VALUES ${regionValues})
     SELECT candidate.region_id
     FROM candidate_regions candidate
     WHERE EXISTS (
       SELECT 1
       FROM observations o
       JOIN check_runs cr ON cr.id = o.check_run_id
       WHERE o.monitor_id = ? AND o.region_id = candidate.region_id
         AND o.success = 0 AND o.scheduled_window >= ?
         AND cr.monitor_id = o.monitor_id
         AND cr.status IN ('complete', 'partial') AND cr.window_started_at >= ?
       LIMIT 1
     )`,
    [monitorId, sinceIso, sinceIso],
  );

  return Promise.all(
    failedRegions.map(async ({ region_id }) => {
      // Drive this lookup from the monitor/time index and stop after five
      // finalized rounds. The previous window query ranked the monitor's
      // entire history once for every failed region before discarding all but
      // these same five rows.
      const recent = await all<{ success: number }>(
        db,
        `SELECT o.success
         FROM check_runs cr
         JOIN observations o ON o.check_run_id = cr.id AND o.region_id = ?
         WHERE cr.monitor_id = ? AND cr.status IN ('complete', 'partial')
         ORDER BY cr.window_started_at DESC
         LIMIT 5`,
        [region_id, monitorId],
      );
      const consecutiveSuccesses = recent.findIndex((row) => row.success !== 1);
      const successCount = consecutiveSuccesses === -1 ? recent.length : consecutiveSuccesses;
      return {
        region_id,
        state:
          recent.length === 5 && successCount === 5
            ? 'up'
            : successCount >= 2
              ? 'recovering'
              : 'down',
      } satisfies RecoveryRow;
    }),
  );
}

function overallRecovery(rows: readonly RecoveryRow[]): 'up' | 'down' | 'recovering' | null {
  if (rows.some((row) => row.state === 'down')) return 'down';
  if (rows.some((row) => row.state === 'recovering')) return 'recovering';
  if (rows.some((row) => row.state === 'up')) return 'up';
  return null;
}

export type MonitorSnapshotBase = Omit<MonitorReportSnapshot, 'latency' | 'latencyByRange'>;

/** Build summary and uptime; the full-history builder adds the chart payloads. */
export async function buildMonitorSnapshotBase(
  db: D1Database,
  monitorId: string,
  options: ReportBuildOptions,
): Promise<MonitorSnapshotBase | null> {
  const monitor = await first<MonitorRow>(db, 'SELECT * FROM monitors WHERE id = ? LIMIT 1', [
    monitorId,
  ]);
  if (!monitor) return null;
  const regionRows = await all<{ region_id: RegionId }>(
    db,
    'SELECT region_id FROM monitor_regions WHERE monitor_id = ? ORDER BY region_id',
    [monitorId],
  );
  const regions = regionRows.map((row) => row.region_id);
  const { dayKeys, sinceDay, today } = uptimeDayKeys(options.now);
  const uptime = summarizeUptime(await loadUptimeRows(db, monitorId, sinceDay), dayKeys);
  const recovery = await loadRegionRecovery(db, monitorId, `${today}T00:00:00.000Z`);
  uptime.recoveryStatus = overallRecovery(recovery);

  const summary = await buildPublicSummary(db, monitor, regions);
  return {
    schemaVersion: '1',
    generatedAt: nowIso(options.now),
    latestObservationAt: latestSummaryObservation(summary),
    staleAfterSeconds: options.staleAfterSeconds,
    summary,
    uptime,
  };
}

/**
 * Assemble every scheduled status page from shared monitor evidence using
 * bounded bulk queries. Individual monitor reports refresh independently.
 */
export async function buildReportCohortData(
  db: D1Database,
  options: ReportBuildOptions,
): Promise<ReportCohortData> {
  const pages = await all<StatusPageRow>(
    db,
    'SELECT id, title, public_slug FROM status_pages ORDER BY created_at ASC',
  );
  const groups = await all<StatusPageGroupD1 & { status_page_id: string }>(
    db,
    `SELECT id, status_page_id, title, position, width, show_badges
     FROM status_page_groups ORDER BY status_page_id, position`,
  );
  const memberships = await all<StatusPageMonitorD1 & { status_page_id: string; position: number }>(
    db,
    `SELECT spm.status_page_id, spm.group_id, spm.position, m.*,
       '[]' AS notification_service_ids
     FROM status_page_monitors spm
     JOIN monitors m ON m.id = spm.monitor_id
     ORDER BY spm.status_page_id, spm.position`,
  );
  const monitorRows = await all<StatusPageMonitorD1>(
    db,
    `SELECT NULL AS group_id, m.*, '[]' AS notification_service_ids
     FROM monitors m
     WHERE EXISTS (SELECT 1 FROM status_page_monitors spm WHERE spm.monitor_id = m.id)
     ORDER BY m.id`,
  );
  const monitorIds = monitorRows.map((monitor) => monitor.id);
  const [summaries, uptimeResult] = await Promise.all([
    monitorSummaries(db, monitorRows, { warn: () => undefined }),
    monitorUptimeDetailsBulkCached(db, monitorIds, options.now, options.closedDaysCache),
  ]);
  const uptimeDetails = uptimeResult.details;
  const summariesById = new Map(summaries.map((summary) => [summary.monitor.id, summary]));
  const monitors = new Map<string, CohortMonitorData>();
  for (const monitor of monitorRows) {
    const summary = summariesById.get(monitor.id);
    const details = uptimeDetails.get(monitor.id);
    if (!summary || !details) continue;
    const publicSummary = toPublicMonitorSummary(summary as MonitorSummary);
    const latestObservationAt = latestSummaryObservation(publicSummary);
    monitors.set(monitor.id, {
      summary: publicSummary,
      uptime: details.uptime,
      latestObservationAt,
    });
  }

  const statusPages = new Map<string, StatusPageReportSnapshot>();
  for (const page of pages) {
    statusPages.set(
      page.id,
      statusPageSnapshot(
        page,
        groups.filter((group) => group.status_page_id === page.id),
        memberships.filter((member) => member.status_page_id === page.id),
        (id) => ({
          summary: monitors.get(id)?.summary,
          uptime: monitors.get(id)?.uptime,
          affectedRegionIds: uptimeDetails.get(id)?.affectedRegionIds ?? [],
        }),
        options,
      ),
    );
  }
  return uptimeResult.closedDaysCache
    ? { monitors, statusPages, closedDaysCache: uptimeResult.closedDaysCache }
    : { monitors, statusPages };
}

interface StatusPageRow {
  id: string;
  title: string;
  public_slug: string | null;
}

interface StatusPageGroupD1 {
  id: string;
  title: string;
  position: number;
  width: 'full' | 'half';
  show_badges: number;
}

interface StatusPageMonitorD1 extends MonitorRow {
  group_id: string;
  notification_service_ids: string;
}

function latestSummaryObservation(summary: PublicMonitorSummary | MonitorSummary): string | null {
  return (
    Object.values(summary.latestByRegion)
      .flatMap((observation) => (observation ? [observation.startedAt] : []))
      .sort()
      .at(-1) ?? null
  );
}

/** Project the cohort's shared monitor evidence into each status page. */
function statusPageSnapshot(
  page: StatusPageRow,
  groups: readonly StatusPageGroupD1[],
  monitors: readonly StatusPageMonitorD1[],
  resolve: (id: string) => {
    summary: PublicMonitorSummary | MonitorSummary | undefined;
    uptime: MonitorReportSnapshot['uptime'] | undefined;
    affectedRegionIds: RegionId[];
  },
  options: ReportBuildOptions,
): StatusPageReportSnapshot {
  let latestObservationAt: string | null = null;
  const pageGroups = groups.map((group) => ({
    id: group.id,
    title: group.title,
    width: group.width ?? 'full',
    showBadges: toBoolean(group.show_badges),
    monitors: monitors
      .filter((monitor) => monitor.group_id === group.id)
      .map((monitor) => {
        const { summary, uptime, affectedRegionIds } = resolve(monitor.id);
        const latest = summary ? latestSummaryObservation(summary) : null;
        if (latest && latest > (latestObservationAt ?? '')) latestObservationAt = latest;
        return {
          id: monitor.id,
          name: monitor.name,
          url: monitor.url,
          publicSlug: monitor.public_slug,
          badge: summary?.monitor.badge ?? null,
          uptimeThresholds: parseUptimeThresholds(monitor.uptime_thresholds),
          uptimePercentage: uptime?.uptimePercentage ?? null,
          status:
            summary?.status === 'degraded'
              ? ('down' as const)
              : (summary?.status ?? ('unknown' as const)),
          configuredRegionCount: summary?.monitor.regionIds.length ?? 0,
          affectedRegionIds,
          recoveryStatus: uptime?.recoveryStatus ?? null,
          days: uptime?.days ?? [],
        };
      }),
  }));
  return {
    schemaVersion: '1',
    generatedAt: nowIso(options.now),
    latestObservationAt,
    staleAfterSeconds: options.staleAfterSeconds,
    statusPage: {
      id: page.id,
      title: page.title,
      publicSlug: page.public_slug,
      groups: pageGroups,
    },
  };
}
