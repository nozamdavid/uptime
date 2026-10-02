import { hashPassword } from '@uptime/cloudflare';
import { createD1Adapter, createTestDatabase } from '@uptime/cloudflare/testing';
import type { TestD1Database } from '@uptime/cloudflare/testing';

import { buildTestApp, defaultTestConfig, type TestApp } from './harness.js';

export const TEST_PASSWORD = 'correct horse battery staple';

export interface SeedOptions {
  regions?: string[];
  passwordHash?: string;
  config?: Parameters<typeof buildTestApp>[0]['config'];
  now?: () => Date;
  notificationFetch?: typeof fetch;
}

export interface TestContext {
  app: TestApp;
  db: TestD1Database;
  sqlite: ReturnType<typeof createTestDatabase>;
  passwordHash: string;
}

/** Seed the shared SQLite database and build a router bound to it. */
export async function createTestContext(options: SeedOptions = {}): Promise<TestContext> {
  const passwordHash = options.passwordHash ?? (await hashPassword(TEST_PASSWORD));
  const sqlite = createTestDatabase();
  const db = createD1Adapter(sqlite);
  sqlite
    .prepare(
      `INSERT INTO admins (id, singleton_key, email, password_hash)
       VALUES ('00000000-0000-4000-8000-000000000001', 1, ?, ?)`,
    )
    .run(defaultTestConfig.adminEmail, passwordHash);
  const app = buildTestApp({
    db,
    config: { ...defaultTestConfig, adminPasswordHash: passwordHash, ...options.config },
    ...(options.now ? { now: options.now } : {}),
    ...(options.notificationFetch ? { notificationFetch: options.notificationFetch } : {}),
  });
  return { app, db, sqlite, passwordHash };
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
  updatedAt?: string;
}

export function seedMonitor(
  sqlite: ReturnType<typeof createTestDatabase>,
  input: SeedMonitorInput = {},
): string {
  const id = input.id ?? '30000000-0000-4000-8000-000000000001';
  const timestamp = input.createdAt ?? '2026-09-16T10:00:00.000Z';
  sqlite
    .prepare(
      `INSERT INTO monitors (id, name, url, interval_seconds, timeout_ms, enabled,
         dns_diagnostics_enabled, is_public, public_slug, badge_id, uptime_thresholds,
         outage_threshold, recovery_threshold, repeat_notification_minutes, next_check_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, 2, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      input.name ?? 'Example',
      input.url ?? 'https://example.com',
      input.intervalSeconds ?? 300,
      input.timeoutMs ?? 10_000,
      input.enabled === false ? 0 : 1,
      input.dnsDiagnosticsEnabled ? 1 : 0,
      input.isPublic ? 1 : 0,
      input.publicSlug ?? null,
      input.badgeId ?? null,
      JSON.stringify(input.thresholds ?? { green: 99.5, lightGreen: 99, orange: 90 }),
      input.nextCheckAt ?? '2026-09-16T11:00:00.000Z',
      timestamp,
      input.updatedAt ?? timestamp,
    );
  for (const region of input.regions ?? ['us-east']) {
    sqlite
      .prepare('INSERT INTO monitor_regions (monitor_id, region_id) VALUES (?, ?)')
      .run(id, region);
  }
  return id;
}

export function seedRun(
  sqlite: ReturnType<typeof createTestDatabase>,
  input: {
    id?: string;
    monitorId: string;
    windowStartedAt?: string;
    status?: 'pending' | 'complete' | 'partial';
    expectedRegionCount?: number;
    expectedRegions?: string[];
    monitorUrl?: string;
    timeoutMs?: number;
    dnsDiagnosticsEnabled?: boolean;
    deadlineAt?: string;
  },
): string {
  const id = input.id ?? crypto.randomUUID();
  sqlite
    .prepare(
      `INSERT INTO check_runs (id, monitor_id, window_started_at, status, expected_region_count,
         expected_regions, monitor_url, timeout_ms, dns_diagnostics_enabled, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.monitorId,
      input.windowStartedAt ?? '2026-09-16T10:00:00.000Z',
      input.status ?? 'pending',
      input.expectedRegionCount ?? 1,
      JSON.stringify(input.expectedRegions ?? ['us-east']),
      input.monitorUrl ?? 'https://example.com',
      input.timeoutMs ?? 10_000,
      input.dnsDiagnosticsEnabled ? 1 : 0,
      input.deadlineAt ?? '2026-09-16T10:30:00.000Z',
    );
  return id;
}

export function seedObservation(
  sqlite: ReturnType<typeof createTestDatabase>,
  input: {
    id?: string;
    checkRunId: string;
    monitorId: string;
    regionId?: string;
    scheduledWindow?: string;
    status?: 'success' | 'http_failure' | 'network_failure';
    success?: boolean;
    httpStatus?: number | null;
    responseMs?: number | null;
    totalMs?: number | null;
    errorCode?: string | null;
    startedAt?: string;
    completedAt?: string | null;
  },
): string {
  const id = input.id ?? crypto.randomUUID();
  const success =
    input.success ?? (input.status !== 'http_failure' && input.status !== 'network_failure');
  const scheduledWindow =
    input.scheduledWindow ??
    (
      sqlite
        .prepare('SELECT window_started_at FROM check_runs WHERE id = ?')
        .get(input.checkRunId) as { window_started_at?: string } | undefined
    )?.window_started_at ??
    '2026-09-16T10:00:00.000Z';
  sqlite
    .prepare(
      `INSERT INTO observations (id, check_run_id, monitor_id, region_id, scheduled_window, status,
         success, http_status, response_ms, total_ms, error_code, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.checkRunId,
      input.monitorId,
      input.regionId ?? 'us-east',
      scheduledWindow,
      input.status ?? 'success',
      success ? 1 : 0,
      input.httpStatus ?? (success ? 200 : null),
      input.responseMs ?? (success ? 100 : null),
      input.totalMs ?? null,
      input.errorCode ?? null,
      input.startedAt ?? '2026-09-16T10:00:05.000Z',
      input.completedAt ?? '2026-09-16T10:00:06.000Z',
    );
  return id;
}

/** Authenticate and return the session cookie header. */
export async function login(
  app: TestApp,
  password = TEST_PASSWORD,
): Promise<{ cookie: string; response: Response }> {
  const response = await app.fetch(
    new Request('https://api.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  );
  const setCookie = response.headers.get('set-cookie') ?? '';
  return { cookie: setCookie.split(';')[0] ?? '', response };
}

export function request(
  app: TestApp,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return app.fetch(new Request(`https://api.test${path}`, { ...init, headers }));
}
