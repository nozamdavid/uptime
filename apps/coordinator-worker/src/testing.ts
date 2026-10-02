import {
  createD1Adapter,
  createTestDatabase,
  type TestD1Database,
} from '@uptime/cloudflare/testing';
import type { RegionId } from '@uptime/regions';

export interface SeededDatabase {
  sqlite: ReturnType<typeof createTestDatabase>;
  db: TestD1Database;
}

/** In-memory SQLite with the shared D1 migration plus a `D1Database` adapter. */
export function makeDatabase(): SeededDatabase {
  const sqlite = createTestDatabase();
  return { sqlite, db: createD1Adapter(sqlite) };
}

export interface MonitorSeed {
  id?: string;
  name?: string | null;
  url?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  enabled?: 0 | 1;
  dnsDiagnosticsEnabled?: 0 | 1;
  isPublic?: 0 | 1;
  publicSlug?: string | null;
  outageThreshold?: number;
  recoveryThreshold?: number;
  repeatNotificationMinutes?: number | null;
  reportIntervalSeconds?: number;
  nextCheckAt?: string;
  updatedAt?: string;
  regions?: RegionId[];
}

let counter = 0;

export function seedMonitor(
  sqlite: ReturnType<typeof createTestDatabase>,
  seed: MonitorSeed = {},
): string {
  counter += 1;
  const id = seed.id ?? `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  sqlite
    .prepare(
      `INSERT INTO monitors (
         id, name, url, interval_seconds, timeout_ms, enabled, dns_diagnostics_enabled,
         is_public, public_slug, outage_threshold, recovery_threshold,
         repeat_notification_minutes, report_interval_seconds, next_check_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      seed.name ?? 'Example',
      seed.url ?? 'https://example.com/health',
      seed.intervalSeconds ?? 60,
      seed.timeoutMs ?? 1_000,
      seed.enabled ?? 1,
      seed.dnsDiagnosticsEnabled ?? 0,
      seed.isPublic ?? 0,
      seed.publicSlug ?? null,
      seed.outageThreshold ?? 3,
      seed.recoveryThreshold ?? 2,
      seed.repeatNotificationMinutes ?? null,
      seed.reportIntervalSeconds ?? 60,
      seed.nextCheckAt ?? '2026-09-20T10:00:00.000Z',
      seed.updatedAt ?? '2026-09-01T00:00:00.000Z',
    );
  for (const region of seed.regions ?? ['us-east', 'eu-west']) {
    sqlite
      .prepare('INSERT INTO monitor_regions (monitor_id, region_id) VALUES (?, ?)')
      .run(id, region);
  }
  return id;
}

export interface RoundSeed {
  id: string;
  monitorId: string;
  windowStartedAt: string;
  status?: 'pending' | 'complete' | 'partial';
  expectedRegionCount?: number;
  expectedRegions?: RegionId[];
  timeoutMs?: number;
  deadlineAt?: string;
  createdAt?: string;
  /** Explicit marker; defaults to the window start when status is finalized. */
  finalizedAt?: string | null;
  completedAt?: string | null;
}

export function seedRound(sqlite: ReturnType<typeof createTestDatabase>, seed: RoundSeed): void {
  const status = seed.status ?? 'pending';
  const finalizedAt =
    seed.finalizedAt === undefined
      ? status === 'pending'
        ? null
        : (seed.completedAt ?? seed.createdAt ?? seed.windowStartedAt)
      : seed.finalizedAt;
  sqlite
    .prepare(
      `INSERT INTO check_runs (
         id, monitor_id, window_started_at, status, expected_region_count, expected_regions,
         monitor_url, timeout_ms, deadline_at, created_at, completed_at, finalized_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.id,
      seed.monitorId,
      seed.windowStartedAt,
      status,
      seed.expectedRegionCount ?? seed.expectedRegions?.length ?? 1,
      JSON.stringify(seed.expectedRegions ?? ['us-east']),
      'https://example.com/health',
      seed.timeoutMs ?? 1_000,
      seed.deadlineAt ??
        new Date(
          Date.parse(seed.windowStartedAt) + (seed.timeoutMs ?? 1_000) + 15_000,
        ).toISOString(),
      seed.createdAt ?? seed.windowStartedAt,
      seed.completedAt ??
        (status === 'pending' ? null : (seed.finalizedAt ?? seed.windowStartedAt)),
      finalizedAt,
    );
}

export interface ObservationSeed {
  id?: string;
  checkRunId: string;
  monitorId: string;
  regionId: RegionId;
  scheduledWindow: string;
  success: boolean;
  status?: 'success' | 'http_failure' | 'network_failure';
  responseMs?: number | null;
  errorCode?: string | null;
  startedAt?: string;
  completedAt?: string | null;
  createdAt?: string;
}

export function seedObservation(
  sqlite: ReturnType<typeof createTestDatabase>,
  seed: ObservationSeed,
): void {
  const success = seed.success;
  sqlite
    .prepare(
      `INSERT INTO observations (
         id, check_run_id, monitor_id, region_id, scheduled_window, status, success,
         http_status, response_ms, error_code, started_at, completed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (monitor_id, region_id, scheduled_window) DO NOTHING`,
    )
    .run(
      seed.id ?? crypto.randomUUID(),
      seed.checkRunId,
      seed.monitorId,
      seed.regionId,
      seed.scheduledWindow,
      seed.status ?? (success ? 'success' : 'http_failure'),
      success ? 1 : 0,
      success ? 200 : 503,
      seed.responseMs ?? null,
      seed.errorCode ?? null,
      seed.startedAt ?? seed.scheduledWindow,
      seed.completedAt ?? null,
      seed.createdAt ?? seed.scheduledWindow,
    );
}

export function count(sqlite: ReturnType<typeof createTestDatabase>, table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
}
