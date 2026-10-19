import type { RegionId } from '@uptime/regions';
import {
  createPostgresTestDatabase,
  loadPostgresMigrations,
} from '@uptime/cloudflare/testing/postgres';

/** Native fixtures own disposable schemas; they never share the API harness. */
export async function makePostgresDatabase() {
  const migrations = (
    await loadPostgresMigrations(
      new URL('../../../packages/cloudflare/src/postgres/migrations/tenant/', import.meta.url),
    )
  ).filter(
    (migration) =>
      Number(migration.id.slice(0, 4)) <= 12 ||
      migration.id === '0013_retire_report_latency_changefeed.sql' ||
      migration.id === '0014_simplify_observation_indexes.sql' ||
      migration.id === '0017_status_page_font_family.sql',
  );
  const tables = [
    'admins',
    'sessions',
    'badges',
    'monitors',
    'status_pages',
    'status_page_groups',
    'status_page_monitors',
    'monitor_regions',
    'check_runs',
    'observations',
    'network_diagnostics',
    'notification_services',
    'monitor_notification_services',
    'monitor_notification_state',
    'notification_deliveries',
    'monitor_daily_uptime',
    'jobs',
    'report_publications',
    'report_cache_revisions',
    'report_latency_changes',
    'monitor_report_refresh',
    'monitor_latency_hourly',
    'monitor_latency_dirty',
    'monitor_latency_coverage',
    'notification_history',
  ];
  return createPostgresTestDatabase({ migrations, tables, profile: 'coordinator-native' });
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
