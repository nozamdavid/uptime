import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { regionIds, type RegionId } from '@uptime/contracts';
import postgres, { type Sql } from 'postgres';

const sourceBaseUrl = 'https://status.bsky.app/api/getMonitorList/zwOvMT8x16';
const importSource = 'status.bsky.app:zwOvMT8x16';
const defaultIntervalSeconds = 300;
const defaultTimeoutMs = 10_000;

interface SourceDay {
  date: string;
  ratio: string;
}

interface SourceMonitor {
  monitorId: number;
  name: string;
  type: string;
  dailyRatios: SourceDay[];
}

interface SourcePage {
  status: string;
  data: SourceMonitor[];
  psp: { totalMonitors: number; perPage: number; timezone: string };
}

interface PreparedMonitor {
  sourceId: number;
  name: string;
  url: string;
  canonicalUrl: string;
  regionIds: readonly RegionId[];
  usedRegionFallback: boolean;
  days: Array<{ date: string; uptimePercentage: number }>;
}

interface ImportSummary {
  sourceMonitors: number;
  createdMonitors: number;
  matchedMonitors: number;
  importedDays: number;
  verifiedStoredDays: number;
  verifiedStoredMonitors: number;
  storedDaysAfterCutoff: number;
  throughDate: string;
  fallbackUrls: string[];
}

export function canonicalMonitorUrl(value: string): string {
  const parsed = new URL(value.trim());
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

export function inferMonitorRegions(url: string): {
  regionIds: readonly RegionId[];
  usedFallback: boolean;
} {
  const hostname = new URL(url).hostname.toLowerCase();
  const match = hostname.match(/(?:^|\.)(us-east|us-west)(?:\.|$)/);
  if (match?.[1] === 'us-east' || match?.[1] === 'us-west') {
    return { regionIds: [match[1]], usedFallback: false };
  }
  return { regionIds, usedFallback: true };
}

export function utcYesterday(currentTime = new Date()): string {
  const yesterday = new Date(currentTime);
  yesterday.setUTCHours(0, 0, 0, 0);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

function prepareMonitor(source: SourceMonitor, throughDate: string): PreparedMonitor {
  if (source.type !== 'HTTP(s)' || !source.name) {
    throw new Error(`Unsupported source monitor ${source.monitorId}`);
  }
  const url = source.name.match(/^https?:\/\//i) ? source.name : `https://${source.name}`;
  const inferred = inferMonitorRegions(url);
  const days = source.dailyRatios
    .filter((day) => day.date <= throughDate)
    .map((day) => {
      const uptimePercentage = Number(day.ratio);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
        !Number.isFinite(uptimePercentage) ||
        uptimePercentage < 0 ||
        uptimePercentage > 100
      ) {
        throw new Error(`Invalid history for source monitor ${source.monitorId} on ${day.date}`);
      }
      return { date: day.date, uptimePercentage };
    });
  return {
    sourceId: source.monitorId,
    name: source.name,
    url,
    canonicalUrl: canonicalMonitorUrl(url),
    regionIds: inferred.regionIds,
    usedRegionFallback: inferred.usedFallback,
    days,
  };
}

async function fetchSourceMonitors(fetcher: typeof fetch): Promise<SourceMonitor[]> {
  const first = await fetchSourcePage(fetcher, 1);
  const pageCount = Math.ceil(first.psp.totalMonitors / first.psp.perPage);
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => fetchSourcePage(fetcher, index + 2)),
  );
  const monitors = [first, ...remaining].flatMap((page) => page.data);
  if (monitors.length !== first.psp.totalMonitors) {
    throw new Error(`Source returned ${monitors.length} of ${first.psp.totalMonitors} monitors`);
  }
  if (new Set(monitors.map((monitor) => monitor.monitorId)).size !== monitors.length) {
    throw new Error('Source returned duplicate monitor IDs');
  }
  return monitors;
}

async function fetchSourcePage(fetcher: typeof fetch, page: number): Promise<SourcePage> {
  const response = await fetcher(`${sourceBaseUrl}?page=${page}`);
  if (!response.ok) throw new Error(`Source page ${page} returned HTTP ${response.status}`);
  const payload = (await response.json()) as Partial<SourcePage>;
  if (
    payload.status !== 'ok' ||
    !Array.isArray(payload.data) ||
    !payload.psp ||
    !Number.isInteger(payload.psp.totalMonitors) ||
    !Number.isInteger(payload.psp.perPage)
  ) {
    throw new Error(`Source page ${page} has an unexpected shape`);
  }
  return payload as SourcePage;
}

async function importMonitors(
  database: Sql,
  prepared: readonly PreparedMonitor[],
  throughDate: string,
  dryRun: boolean,
): Promise<ImportSummary> {
  const existing = await database<{ id: string; url: string }[]>`
    select id, url from monitors order by created_at, id
  `;
  const existingByUrl = new Map<string, string>();
  for (const monitor of existing) {
    const canonical = canonicalMonitorUrl(monitor.url);
    if (!existingByUrl.has(canonical)) existingByUrl.set(canonical, monitor.id);
  }

  const matchedMonitors = prepared.filter((monitor) => existingByUrl.has(monitor.canonicalUrl));
  const fallbackUrls = prepared
    .filter((monitor) => monitor.usedRegionFallback)
    .map((monitor) => monitor.url);
  const importedDays = prepared.reduce((total, monitor) => total + monitor.days.length, 0);
  if (!dryRun) {
    await database.begin(async (transaction) => {
      for (const monitor of prepared) {
        let monitorId = existingByUrl.get(monitor.canonicalUrl);
        if (!monitorId) {
          const inserted = await transaction<{ id: string }[]>`
            insert into monitors (
              name, url, interval_seconds, timeout_ms, enabled,
              dns_diagnostics_enabled, is_public, next_check_at
            ) values (
              ${monitor.name}, ${monitor.url}, ${defaultIntervalSeconds}, ${defaultTimeoutMs},
              true, false, false,
              to_timestamp(ceil(extract(epoch from now()) / ${defaultIntervalSeconds}) * ${defaultIntervalSeconds})
            )
            returning id
          `;
          monitorId = inserted[0]?.id;
          if (!monitorId) throw new Error(`Monitor insert failed for ${monitor.url}`);
          existingByUrl.set(monitor.canonicalUrl, monitorId);
          for (const regionId of monitor.regionIds) {
            await transaction`
              insert into monitor_regions (monitor_id, region_id)
              values (${monitorId}, ${regionId})
              on conflict do nothing
            `;
          }
        }
        if (monitor.days.length > 0) {
          const weightResult = await transaction<{ weight: number }[]>`
            select (
              86400.0 / m.interval_seconds * greatest(count(mr.region_id), 1)
            )::double precision as weight
            from monitors m
            left join monitor_regions mr on mr.monitor_id = m.id
            where m.id = ${monitorId}
            group by m.id, m.interval_seconds
          `;
          const importedDayWeight = Number(weightResult[0]?.weight);
          if (!Number.isFinite(importedDayWeight) || importedDayWeight <= 0) {
            throw new Error(`Could not calculate imported daily weight for ${monitor.url}`);
          }
          const history = monitor.days.map((day) => ({
            day: day.date,
            uptime_percentage: day.uptimePercentage,
          }));
          await transaction`
            insert into monitor_daily_uptime (
              monitor_id, day, uptime_percentage, average_response_ms, weight,
              received_count, success_count, source, finalized_at, created_at, updated_at
            )
            select ${monitorId}, imported.day::date, imported.uptime_percentage, null,
              ${importedDayWeight},
              null, null, ${importSource}, now(), now(), now()
            from jsonb_to_recordset(${transaction.json(history)}::jsonb) as imported(
              day text,
              uptime_percentage double precision
            )
            on conflict (monitor_id, day) do update set
              uptime_percentage = excluded.uptime_percentage,
              average_response_ms = excluded.average_response_ms,
              weight = excluded.weight,
              received_count = excluded.received_count,
              success_count = excluded.success_count,
              source = excluded.source,
              finalized_at = excluded.finalized_at,
              updated_at = now()
          `;
        }
      }
    });
  }
  const firstDate = prepared.flatMap((monitor) => monitor.days.map((day) => day.date)).sort()[0];
  const verification = firstDate
    ? (
        await database<{ storedDays: number; storedMonitors: number; daysAfterCutoff: number }[]>`
          select
            count(*) filter (
              where day between ${firstDate}::date and ${throughDate}::date
            )::integer as "storedDays",
            count(distinct monitor_id) filter (
              where day between ${firstDate}::date and ${throughDate}::date
            )::integer as "storedMonitors",
            count(*) filter (where day > ${throughDate}::date)::integer as "daysAfterCutoff"
          from monitor_daily_uptime
          where source = ${importSource}
        `
      )[0]
    : undefined;
  const verifiedStoredDays = Number(verification?.storedDays ?? 0);
  const verifiedStoredMonitors = Number(verification?.storedMonitors ?? 0);
  const storedDaysAfterCutoff = Number(verification?.daysAfterCutoff ?? 0);
  if (
    !dryRun &&
    (verifiedStoredDays !== importedDays ||
      verifiedStoredMonitors !== prepared.length ||
      storedDaysAfterCutoff !== 0)
  ) {
    throw new Error('Post-import history verification failed');
  }
  return {
    sourceMonitors: prepared.length,
    createdMonitors: prepared.length - matchedMonitors.length,
    matchedMonitors: matchedMonitors.length,
    importedDays,
    verifiedStoredDays,
    verifiedStoredMonitors,
    storedDaysAfterCutoff,
    throughDate,
    fallbackUrls,
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    try {
      loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const dryRun = process.argv.includes('--dry-run');
  const throughDate = utcYesterday();
  const sourceMonitors = await fetchSourceMonitors(fetch);
  const prepared = sourceMonitors.map((monitor) => prepareMonitor(monitor, throughDate));
  const database = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const summary = await importMonitors(database, prepared, throughDate, dryRun);
    console.log(JSON.stringify({ dryRun, ...summary }, null, 2));
  } finally {
    await database.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
