import {
  all,
  first,
  nowIso,
  run,
  type D1Database,
  type R2Bucket,
  type ReportPublicationRow,
} from '@uptime/cloudflare';
import type { ReportUptimeClosedDaysCache } from '@uptime/api-worker/queries';
import type { ReportConfig } from './env.js';
import { buildReportCohortData } from './reports.js';
import { reportLeaseSeconds } from './state.js';
import { startIncidentMonitorRefreshes } from './on-demand-monitor.js';

export function monitorObjectKey(reference: string): string {
  return `public/monitors/${encodeURIComponent(reference)}.json`;
}

export function statusPageObjectKey(reference: string): string {
  return `public/status-pages/${encodeURIComponent(reference)}.json`;
}

export const statusPageIndexObjectKey = 'public/status-pages.json';
export const reportCohortPointerKey = 'public/cohort.json';
export const reportCohortUptimeCacheKey = 'private/report-cohort-closed-days.json';
const reportObjectByteLimit = 8 * 1_024 * 1_024;

export function reportCohortStatusPageKey(generation: string, reference: string): string {
  return `public/cohorts/${generation}/status-pages/${encodeURIComponent(reference)}.json`;
}

export function reportCohortIndexKey(generation: string): string {
  return `public/cohorts/${generation}/status-pages.json`;
}

interface ReportCohortPointer {
  schemaVersion: '1';
  generation: string;
  previousGenerations: string[];
  generatedAt: string;
  sourceWatermark: string;
}

export function reportReference(slug: string | null, id: string): string {
  return slug ?? id;
}

interface DesiredPublication {
  reportKey: string;
  kind: 'status-page' | 'index';
  statusPageId: string | null;
  objectKey: string;
  reportIntervalSeconds: number;
}

export interface PublishResult {
  scheduled: number;
  published: number;
  removed: number;
  skipped: number;
  failed: number;
}

/** Individual monitor reports are built on demand, outside the scheduled cohort. */
export async function desiredPublications(
  db: D1Database,
  reportIntervalSeconds = 60,
): Promise<DesiredPublication[]> {
  const pages = await all<{
    id: string;
    public_slug: string | null;
    report_interval_seconds: number;
  }>(db, 'SELECT id, public_slug, report_interval_seconds FROM status_pages ORDER BY id');
  return [
    ...pages.map((page) => ({
      reportKey: `status-page:${page.id}`,
      kind: 'status-page' as const,
      statusPageId: page.id,
      objectKey: statusPageObjectKey(reportReference(page.public_slug, page.id)),
      reportIntervalSeconds: Math.max(reportIntervalSeconds, page.report_interval_seconds),
    })),
    {
      reportKey: 'index',
      kind: 'index',
      statusPageId: null,
      objectKey: statusPageIndexObjectKey,
      reportIntervalSeconds,
    },
  ];
}

async function readObjectBody(reports: R2Bucket, key: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const object = await timedReportRead(reports.get(key), key, (lateObject) => {
        if (lateObject) void lateObject.body.cancel().catch(() => undefined);
      });
      if (!object) return null;
      if (
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        object.size > reportObjectByteLimit
      ) {
        await object.body.cancel();
        throw new Error(`Report object exceeds byte limit: ${key}`);
      }
      const bytes = await timedReportRead(object.arrayBuffer(), key, () => {
        void object.body.cancel().catch(() => undefined);
      });
      if (bytes.byteLength > reportObjectByteLimit)
        throw new Error(`Report object exceeds byte limit: ${key}`);
      return { text: new TextDecoder().decode(bytes), etag: object.etag };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return null;
}

function timedReportRead<T>(
  operation: Promise<T>,
  key: string,
  onTimeout: (value?: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      reject(new Error(`Timed out reading report object ${key}`));
    }, 15_000);
    operation.then(
      (value) => {
        if (timedOut) {
          onTimeout(value);
          return;
        }
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function renewReportLease(db: D1Database, token: string | undefined): Promise<void> {
  if (!token) return;
  const now = new Date();
  const timestamp = nowIso(now);
  const row = await first<{ lease_token: string }>(
    db,
    `UPDATE jobs SET lease_until = ?, updated_at = ?
     WHERE name = 'reports' AND lease_token = ? AND lease_until > ? RETURNING lease_token`,
    [nowIso(new Date(now.getTime() + reportLeaseSeconds * 1_000)), timestamp, token, timestamp],
  );
  if (row?.lease_token !== token) throw new Error('Report publication lease expired or changed');
}

async function deleteCohortGeneration(reports: R2Bucket, generation: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await reports.list({
      prefix: `public/cohorts/${generation}/`,
      ...(cursor ? { cursor } : {}),
    });
    if (listed.objects.length) await reports.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function cleanupOneOrphanedGeneration(
  reports: R2Bucket,
  retained: ReadonlySet<string>,
  now: Date,
): Promise<void> {
  const listed = await reports.list({ prefix: 'public/cohorts/' });
  const orphan = [
    ...new Set(
      listed.objects.flatMap((object) => {
        const match = object.key.match(/^public\/cohorts\/(\d{13})\//);
        return match ? [match[1]!] : [];
      }),
    ),
  ]
    .filter(
      (generation) => !retained.has(generation) && Number(generation) <= now.getTime() - 600_000,
    )
    .sort()[0];
  if (orphan) await deleteCohortGeneration(reports, orphan);
}

function publicationFingerprint(publications: readonly DesiredPublication[]): string {
  return publications
    .map((item) => `${item.reportKey}\u0000${item.objectKey}\u0000${item.reportIntervalSeconds}`)
    .sort()
    .join('\n');
}

async function cleanupLegacyPublications(config: ReportConfig): Promise<void> {
  const rows = await all<Pick<ReportPublicationRow, 'report_key' | 'object_key'>>(
    config.db,
    "SELECT report_key, object_key FROM report_publications WHERE report_key <> 'cohort' ORDER BY report_key LIMIT 20",
  );
  for (const row of rows) {
    try {
      await config.reports?.delete(row.object_key);
      await run(config.db, 'DELETE FROM report_publications WHERE report_key = ?', [
        row.report_key,
      ]);
    } catch {
      // Keep the row so the next publication retries this bounded cleanup.
    }
  }
}

/** The conditional pointer commits every status page and the index together. */
export async function publishDueReports(
  config: ReportConfig,
  now: Date,
  log: Pick<Console, 'warn' | 'error'>,
  jobLeaseToken?: string,
): Promise<PublishResult> {
  if (!config.reports) {
    log.warn({ event: 'reports_binding_missing' });
    return { scheduled: 0, published: 0, removed: 0, skipped: 0, failed: 0 };
  }
  const reports = config.reports;
  let leaseRenewedAt = 0;
  const maintainPublicationLease = async (force = false): Promise<void> => {
    // Immutable page writes need renewal only as the lease approaches expiry.
    // Always recheck ownership immediately before committing the shared pointer.
    if (force || Date.now() - leaseRenewedAt >= (reportLeaseSeconds * 1_000) / 2) {
      await renewReportLease(config.db, jobLeaseToken);
      leaseRenewedAt = Date.now();
    }
  };
  const desired = await desiredPublications(config.db, config.reportIntervalSeconds);
  const pointerObject = await readObjectBody(reports, reportCohortPointerKey);
  const pointer = pointerObject ? (JSON.parse(pointerObject.text) as ReportCohortPointer) : null;
  if (
    pointer &&
    Math.floor(now.getTime() / (config.reportIntervalSeconds * 1_000)) <=
      Math.floor(Date.parse(pointer.generatedAt) / (config.reportIntervalSeconds * 1_000))
  ) {
    return { scheduled: 0, published: 0, removed: 0, skipped: desired.length, failed: 0 };
  }
  await maintainPublicationLease(true);
  const generation = String(now.getTime());
  const generatedAt = nowIso(now);
  const sourceWatermark = generatedAt;
  const cacheObject = await readObjectBody(reports, reportCohortUptimeCacheKey);
  let closedDaysCache: ReportUptimeClosedDaysCache | undefined;
  try {
    closedDaysCache = cacheObject
      ? (JSON.parse(cacheObject.text) as ReportUptimeClosedDaysCache)
      : undefined;
  } catch {
    // Invalid cache data rebuilds from the daily aggregate.
  }
  const cohort = await buildReportCohortData(config.db, {
    now,
    staleAfterSeconds: config.staleAfterSeconds,
    ...(closedDaysCache ? { closedDaysCache } : {}),
  });
  if (cohort.closedDaysCache)
    await reports.put(reportCohortUptimeCacheKey, JSON.stringify(cohort.closedDaysCache), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
  for (const publication of desired.filter((item) => item.kind === 'status-page')) {
    const snapshot = cohort.statusPages.get(publication.statusPageId!);
    if (!snapshot) throw new Error(`Missing status-page cohort data for ${publication.reportKey}`);
    await maintainPublicationLease();
    await reports.put(
      reportCohortStatusPageKey(
        generation,
        reportReference(snapshot.statusPage.publicSlug, snapshot.statusPage.id),
      ),
      JSON.stringify({
        ...snapshot,
        staleAfterSeconds: publication.reportIntervalSeconds + 120,
        generation,
        sourceWatermark,
      }),
      {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { generation, generatedAt, sourceWatermark },
      },
    );
  }
  const latestObservationAt =
    [...cohort.statusPages.values()]
      .flatMap((page) => (page.latestObservationAt ? [page.latestObservationAt] : []))
      .sort()
      .at(-1) ?? null;
  await reports.put(
    reportCohortIndexKey(generation),
    JSON.stringify({
      schemaVersion: '1',
      generatedAt,
      latestObservationAt,
      staleAfterSeconds: config.staleAfterSeconds,
      generation,
      sourceWatermark,
      statusPages: [...cohort.statusPages.values()].map(({ statusPage }) => ({
        id: statusPage.id,
        title: statusPage.title,
        publicSlug: statusPage.publicSlug,
      })),
    }),
    {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { generation, generatedAt, sourceWatermark },
    },
  );
  const currentDesired = await desiredPublications(config.db, config.reportIntervalSeconds);
  if (publicationFingerprint(currentDesired) !== publicationFingerprint(desired)) {
    await deleteCohortGeneration(reports, generation).catch(() => undefined);
    return {
      scheduled: desired.length,
      published: 0,
      removed: 0,
      skipped: desired.length,
      failed: 0,
    };
  }
  const nextPointer: ReportCohortPointer = {
    schemaVersion: '1',
    generation,
    previousGenerations: pointer
      ? [pointer.generation, ...pointer.previousGenerations].slice(0, 4)
      : [],
    generatedAt,
    sourceWatermark,
  };
  await maintainPublicationLease(true);
  const committed = await reports.put(reportCohortPointerKey, JSON.stringify(nextPointer), {
    onlyIf: pointerObject
      ? { etagMatches: pointerObject.etag }
      : new Headers({ 'if-none-match': '*' }),
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    customMetadata: { generation, generatedAt, sourceWatermark },
  });
  if (committed === null) throw new Error('Report cohort pointer changed during publication');
  await cleanupLegacyPublications(config);
  await run(
    config.db,
    `INSERT INTO report_publications (
    report_key, kind, object_key, schema_version, generation, generated_at, latest_observation_at, source_watermark, status, updated_at
  ) VALUES ('cohort', 'index', ?, '1', ?, ?, ?, ?, 'complete', ?)
  ON CONFLICT (report_key) DO UPDATE SET object_key = excluded.object_key, generation = excluded.generation,
    generated_at = excluded.generated_at, latest_observation_at = excluded.latest_observation_at,
    source_watermark = excluded.source_watermark, status = 'complete', attempts = 0, last_error = NULL,
    lease_until = NULL, lease_token = NULL, updated_at = excluded.updated_at`,
    [
      reportCohortPointerKey,
      Number(generation),
      generatedAt,
      latestObservationAt,
      sourceWatermark,
      generatedAt,
    ],
  );
  if (config.monitorRefresh) {
    // Only committed page content may trigger refreshes. Recovery overrides the
    // summary in the public UI; historical affected regions alone are not issues.
    const incidentMonitorIds = new Set<string>();
    for (const page of cohort.statusPages.values()) {
      for (const group of page.statusPage.groups) {
        for (const monitor of group.monitors) {
          const status = monitor.recoveryStatus ?? monitor.status;
          if (
            cohort.monitors.get(monitor.id)?.summary.monitor.enabled &&
            (status === 'down' || status === 'recovering')
          )
            incidentMonitorIds.add(monitor.id);
        }
      }
    }
    try {
      await startIncidentMonitorRefreshes(
        { DB: config.db, REPORTS: reports, MONITOR_REFRESH: config.monitorRefresh },
        [...incidentMonitorIds],
        now,
        config.monitorRefreshStartLimit?.() ?? 20,
      );
    } catch (error) {
      // A startup outage must not turn successful cohort publication into failure.
      log.error({ event: 'monitor-incident-refresh-startup', error: String(error) });
    }
  }
  const retained = new Set([generation, ...nextPointer.previousGenerations]);
  for (const expired of pointer
    ? [pointer.generation, ...pointer.previousGenerations].filter((value) => !retained.has(value))
    : []) {
    await deleteCohortGeneration(reports, expired).catch(() => undefined);
  }
  await cleanupOneOrphanedGeneration(reports, retained, now).catch(() => undefined);
  return {
    scheduled: desired.length,
    published: desired.length,
    removed: 0,
    skipped: 0,
    failed: 0,
  };
}
