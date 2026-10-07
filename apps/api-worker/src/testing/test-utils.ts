import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { hashPassword } from '@uptime/cloudflare';
import { type Database, type PostgresMigration, pgFirst } from '@uptime/cloudflare/postgres';
import {
  createPostgresTestDatabase,
  loadPostgresMigrations,
  type PostgresTestDatabase,
} from '@uptime/cloudflare/testing/postgres';

import { buildTestApp, defaultTestConfig, type TestApp } from './harness.js';

export const TEST_PASSWORD = 'correct horse battery staple';

export const TENANT_TABLES = [
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
  'workspace_metadata',
  'verified_targets',
] as const;

export function resolveTestAdminUrl(): string {
  if (process.env.POSTGRES_TEST_ADMIN_URL) {
    return process.env.POSTGRES_TEST_ADMIN_URL;
  }
  const passwordFile = join(homedir(), '.config/uptime-postgresql/test-admin-password');
  if (existsSync(passwordFile)) {
    try {
      const password = readFileSync(passwordFile, 'utf8').trim();
      if (password) {
        return `postgresql://uptime_test_admin:${encodeURIComponent(password)}@127.0.0.1:15432/uptime_migration_test`;
      }
    } catch {
      // Fall through to error
    }
  }
  throw new Error(
    'POSTGRES_TEST_ADMIN_URL is required for PostgreSQL API tests. See docs/deployment/postgresql-test-access.md',
  );
}

let cachedMigrations: PostgresMigration[] | null = null;

async function getTenantMigrations(): Promise<PostgresMigration[]> {
  if (!cachedMigrations) {
    const migrationsDir = new URL(
      '../../../../packages/cloudflare/src/postgres/migrations/tenant/',
      import.meta.url,
    );
    cachedMigrations = await loadPostgresMigrations(migrationsDir);
  }
  return cachedMigrations;
}

let sharedPostgresDb: PostgresTestDatabase | null = null;
let sharedPostgresDbPromise: Promise<PostgresTestDatabase> | null = null;

export async function getOrCreateSharedTestDatabase(): Promise<PostgresTestDatabase> {
  if (sharedPostgresDb) return sharedPostgresDb;
  if (!sharedPostgresDbPromise) {
    sharedPostgresDbPromise = (async () => {
      const adminConnectionString = resolveTestAdminUrl();
      const migrations = await getTenantMigrations();
      return await createPostgresTestDatabase({
        adminConnectionString,
        migrations,
        profile: 'full-hosted',
        tables: TENANT_TABLES,
      });
    })();
  }
  sharedPostgresDb = await sharedPostgresDbPromise;
  return sharedPostgresDb;
}

export async function closeSharedTestDatabase(): Promise<void> {
  if (sharedPostgresDb) {
    const toClose = sharedPostgresDb;
    sharedPostgresDb = null;
    sharedPostgresDbPromise = null;
    await toClose.close();
  }
}

afterAll(closeSharedTestDatabase, 120_000);

export interface SeedOptions {
  regions?: string[];
  passwordHash?: string;
  config?: Parameters<typeof buildTestApp>[0]['config'];
  now?: () => Date;
  notificationFetch?: typeof fetch;
  isolated?: boolean;
}

export interface TestContext {
  app: TestApp;
  db: Database;
  postgresDb: PostgresTestDatabase;
  close: () => Promise<void>;
  passwordHash: string;
}

/** Seed the PostgreSQL test database and build a router bound to it. */
export async function createTestContext(options: SeedOptions = {}): Promise<TestContext> {
  let postgresDb: PostgresTestDatabase;
  let isDedicated = false;

  if (options.isolated) {
    const adminConnectionString = resolveTestAdminUrl();
    const migrations = await getTenantMigrations();
    postgresDb = await createPostgresTestDatabase({
      adminConnectionString,
      migrations,
      profile: 'full-hosted',
      tables: TENANT_TABLES,
    });
    isDedicated = true;
  } else {
    postgresDb = await getOrCreateSharedTestDatabase();
  }

  const db = postgresDb.db;

  if (!isDedicated) {
    const rootTables = ['admins', 'badges', 'status_pages', 'notification_services', 'jobs'];
    const truncateSql = `TRUNCATE TABLE ${rootTables.map((t) => db.table(t)).join(', ')} CASCADE`;
    await postgresDb.adminDb.query(truncateSql);
  }

  const passwordHash = options.passwordHash ?? (await hashPassword(TEST_PASSWORD));

  await db.query(
    `INSERT INTO ${db.table('admins')} (id, singleton_key, email, password_hash)
     VALUES ($1, 1, $2, $3)`,
    ['00000000-0000-4000-8000-000000000001', defaultTestConfig.adminEmail, passwordHash],
  );

  const app = buildTestApp({
    db,
    config: { ...defaultTestConfig, adminPasswordHash: passwordHash, ...options.config },
    ...(options.now ? { now: options.now } : {}),
    ...(options.notificationFetch ? { notificationFetch: options.notificationFetch } : {}),
  });

  return {
    app,
    db,
    postgresDb,
    close: async () => {
      if (isDedicated) {
        await postgresDb.close();
      }
    },
    passwordHash,
  };
}

export interface SeedMonitorInput {
  id?: string;
  name?: string;
  url?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  enabled?: boolean;
  dnsDiagnosticsEnabled?: boolean;
  isPublic?: boolean;
  publicSlug?: string | null;
  badgeId?: string | null;
  regions?: string[];
  thresholds?: { green: number; lightGreen: number; orange: number };
  nextCheckAt?: string;
  createdAt?: string;
}

export async function seedMonitor(db: Database, input: SeedMonitorInput = {}): Promise<string> {
  const id = input.id ?? '30000000-0000-4000-8000-000000000001';
  const timestamp = input.createdAt ?? '2026-09-16T10:00:00.000Z';
  await db.query(
    `INSERT INTO ${db.table('monitors')} (id, name, url, interval_seconds, timeout_ms, enabled,
       dns_diagnostics_enabled, is_public, public_slug, badge_id, uptime_thresholds,
       outage_threshold, recovery_threshold, next_check_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 3, 2, $12, $13, $14)`,
    [
      id,
      input.name ?? 'Production API',
      input.url ?? 'https://api.example.com/health',
      input.intervalSeconds ?? 300,
      input.timeoutMs ?? 10_000,
      input.enabled === false ? 0 : 1,
      input.dnsDiagnosticsEnabled ? 1 : 0,
      input.isPublic ? 1 : 0,
      input.publicSlug ?? null,
      input.badgeId ?? null,
      JSON.stringify(input.thresholds ?? { green: 99.5, lightGreen: 99, orange: 90 }),
      input.nextCheckAt ?? timestamp,
      timestamp,
      timestamp,
    ],
  );

  const regions = input.regions ?? ['us-east', 'eu-west'];
  for (const regionId of regions) {
    await db.query(
      `INSERT INTO ${db.table('monitor_regions')} (monitor_id, region_id, created_at)
       VALUES ($1, $2, $3)`,
      [id, regionId, timestamp],
    );
  }
  return id;
}

export interface SeedRunInput {
  id?: string;
  monitorId: string;
  status?: string;
  expectedRegionCount?: number;
  expectedRegions?: string[];
  windowStartedAt?: string;
  deadlineAt?: string;
  dnsDiagnosticsEnabled?: boolean;
}

export async function seedRun(db: Database, input: SeedRunInput): Promise<string> {
  const id = input.id ?? crypto.randomUUID();
  const windowStartedAt = input.windowStartedAt ?? '2026-09-16T10:00:00.000Z';
  const deadlineAt =
    input.deadlineAt ?? new Date(Date.parse(windowStartedAt) + 60_000).toISOString();
  await db.query(
    `INSERT INTO ${db.table('check_runs')} (id, monitor_id, window_started_at, deadline_at, status, expected_region_count,
       expected_regions, monitor_url, timeout_ms, dns_diagnostics_enabled, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'https://api.example.com/health', 10000, $8, $9)`,
    [
      id,
      input.monitorId,
      windowStartedAt,
      deadlineAt,
      input.status ?? 'pending',
      input.expectedRegionCount ?? 2,
      JSON.stringify(input.expectedRegions ?? ['us-east', 'eu-west']),
      input.dnsDiagnosticsEnabled ? 1 : 0,
      windowStartedAt,
    ],
  );
  return id;
}

export interface SeedObservationInput {
  id?: string;
  checkRunId: string;
  monitorId: string;
  regionId?: string;
  success?: boolean;
  status?: string;
  httpStatus?: number | null;
  responseMs?: number | null;
  scheduledWindow?: string;
  startedAt?: string;
  completedAt?: string;
  totalMs?: number | null;
  certificateDaysRemaining?: number | null;
  endpointEvidence?: unknown;
}

export async function seedObservation(db: Database, input: SeedObservationInput): Promise<string> {
  const id = input.id ?? crypto.randomUUID();
  let scheduledWindow = input.scheduledWindow;
  if (!scheduledWindow) {
    const run = await pgFirst<{ window_started_at: string }>(
      db,
      `SELECT window_started_at FROM ${db.table('check_runs')} WHERE id = $1`,
      [input.checkRunId],
    );
    scheduledWindow = run?.window_started_at ?? '2026-09-16T10:00:00.000Z';
  }
  await db.query(
    `INSERT INTO ${db.table('observations')} (id, check_run_id, monitor_id, region_id, scheduled_window, status,
       success, http_status, response_ms, total_ms, error_code, started_at, completed_at, endpoint_evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13)`,
    [
      id,
      input.checkRunId,
      input.monitorId,
      input.regionId ?? 'us-east',
      scheduledWindow,
      input.status ?? (input.success === false ? 'http_failure' : 'success'),
      input.success === false ? 0 : 1,
      input.httpStatus ?? (input.success === false ? 500 : 200),
      input.responseMs ?? 120,
      input.totalMs ?? input.responseMs ?? 120,
      input.startedAt ?? '2026-09-16T10:00:05.000Z',
      input.completedAt ??
        new Date(Date.parse(input.startedAt ?? '2026-09-16T10:00:05.000Z') + 1000).toISOString(),
      input.endpointEvidence ? JSON.stringify(input.endpointEvidence) : null,
    ],
  );
  return id;
}

export async function request(
  app: TestApp,
  path: string,
  options: {
    method?: string;
    body?: string;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (options.cookie) {
    headers.set('cookie', options.cookie);
  }
  return app.fetch(
    new Request(`https://api.internal${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
    }),
  );
}

export async function login(
  app: TestApp,
  password = TEST_PASSWORD,
): Promise<{ response: Response; cookie: string }> {
  const response = await request(app, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { response, cookie };
}
