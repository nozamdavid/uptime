import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { regionIds, type DnsDiagnosticResult, type EndpointEvidence } from '@uptime/contracts';

export const regionIdEnum = pgEnum('region_id', regionIds);
export const runStatusEnum = pgEnum('run_status', ['pending', 'complete', 'partial']);
export const observationStatusEnum = pgEnum('observation_status', [
  'success',
  'http_failure',
  'network_failure',
]);
export const observationErrorCodeEnum = pgEnum('observation_error_code', [
  'timeout',
  'dns',
  'connection',
  'tls',
  'redirect_limit',
  'response_too_large',
  'invalid_response',
  'probe_rejected',
  'probe_unreachable',
  'unknown',
]);
export const networkDiagnosticLifecycleEnum = pgEnum('network_diagnostic_lifecycle', [
  'pending',
  'complete',
  'unavailable',
]);

export const admins = pgTable(
  'admins',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    singletonKey: boolean('singleton_key').notNull().default(true),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('admins_singleton_key_unique').on(table.singletonKey),
    unique('admins_email_unique').on(table.email),
    check('admins_singleton_key_true', sql`${table.singletonKey} = true`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_admin_expires_idx').on(table.adminId, table.expiresAt),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name'),
    url: text('url').notNull(),
    intervalSeconds: integer('interval_seconds').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    dnsDiagnosticsEnabled: boolean('dns_diagnostics_enabled').notNull().default(false),
    isPublic: boolean('is_public').notNull().default(false),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('monitors_http_url', sql`${table.url} ~ '^https?://'`),
    check('monitors_interval_preset', sql`${table.intervalSeconds} in (60, 300, 900, 1800, 3600)`),
    check('monitors_timeout_range', sql`${table.timeoutMs} between 1000 and 30000`),
    check(
      'monitors_timeout_before_interval',
      sql`${table.timeoutMs} < ${table.intervalSeconds} * 1000`,
    ),
    index('monitors_due_idx').on(table.enabled, table.nextCheckAt),
  ],
);

export const monitorRegions = pgTable(
  'monitor_regions',
  {
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    regionId: regionIdEnum('region_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.regionId] }),
    index('monitor_regions_region_idx').on(table.regionId, table.monitorId),
  ],
);

export const checkRuns = pgTable(
  'check_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    status: runStatusEnum('status').notNull().default('pending'),
    expectedRegionCount: integer('expected_region_count').notNull(),
    monitorUrl: text('monitor_url').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    dnsDiagnosticsEnabled: boolean('dns_diagnostics_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('check_runs_monitor_window_unique').on(table.monitorId, table.windowStartedAt),
    unique('check_runs_id_monitor_unique').on(table.id, table.monitorId),
    check(
      'check_runs_region_count',
      sql`${table.expectedRegionCount} between 1 and ${regionIds.length}`,
    ),
    check('check_runs_timeout_range', sql`${table.timeoutMs} between 1000 and 30000`),
    index('check_runs_monitor_time_idx').on(table.monitorId, table.windowStartedAt),
    index('check_runs_status_time_idx').on(table.status, table.windowStartedAt),
  ],
);

export const observations = pgTable(
  'observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    checkRunId: uuid('check_run_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    regionId: regionIdEnum('region_id').notNull(),
    status: observationStatusEnum('status').notNull(),
    success: boolean('success').notNull(),
    httpStatus: integer('http_status'),
    responseMs: doublePrecision('response_ms'),
    totalMs: doublePrecision('total_ms'),
    errorCode: observationErrorCodeEnum('error_code'),
    errorDetail: text('error_detail'),
    placement: text('placement'),
    colo: text('colo'),
    finalUrl: text('final_url'),
    // Target-response evidence. This is intentionally distinct from the probe's
    // configured placement and observed Cloudflare colo fields above.
    endpointEvidence: jsonb('endpoint_evidence').$type<EndpointEvidence>(),
    redirectCount: integer('redirect_count'),
    bodyBytes: integer('body_bytes'),
    probeVersion: text('probe_version'),
    responseMetadata: jsonb('response_metadata').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.checkRunId, table.monitorId],
      foreignColumns: [checkRuns.id, checkRuns.monitorId],
      name: 'observations_run_monitor_fk',
    }).onDelete('cascade'),
    unique('observations_run_region_unique').on(table.checkRunId, table.regionId),
    check(
      'observations_http_status_range',
      sql`${table.httpStatus} is null or ${table.httpStatus} between 100 and 599`,
    ),
    check(
      'observations_nonnegative_timings',
      sql`(${table.responseMs} is null or ${table.responseMs} >= 0) and (${table.totalMs} is null or ${table.totalMs} >= 0)`,
    ),
    check(
      'observations_redirect_range',
      sql`${table.redirectCount} is null or ${table.redirectCount} between 0 and 5`,
    ),
    check(
      'observations_body_bytes_nonnegative',
      sql`${table.bodyBytes} is null or ${table.bodyBytes} >= 0`,
    ),
    check(
      'observations_success_consistent',
      sql`(${table.success} and ${table.status} = 'success') or (not ${table.success} and ${table.status} <> 'success')`,
    ),
    index('observations_monitor_region_time_idx').on(
      table.monitorId,
      table.regionId,
      table.startedAt,
    ),
    index('observations_monitor_time_idx').on(table.monitorId, table.startedAt),
    index('observations_error_time_idx').on(table.errorCode, table.startedAt),
    index('observations_created_at_idx').on(table.createdAt),
  ],
);

/**
 * Daily, non-authoritative network diagnostics are deliberately independent of
 * observations: a diagnostic cannot make an HTTP check fail or change latency.
 */
export const networkDiagnostics = pgTable(
  'network_diagnostics',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    checkRunId: uuid('check_run_id'),
    observationId: uuid('observation_id').references(() => observations.id, {
      onDelete: 'set null',
    }),
    regionId: regionIdEnum('region_id').notNull(),
    kind: text('kind').notNull().default('dns_candidates'),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    lifecycle: networkDiagnosticLifecycleEnum('lifecycle').notNull().default('pending'),
    result: jsonb('result').$type<DnsDiagnosticResult>(),
    failureCode: text('failure_code'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.checkRunId, table.monitorId],
      foreignColumns: [checkRuns.id, checkRuns.monitorId],
      name: 'network_diagnostics_run_monitor_fk',
    }).onDelete('cascade'),
    unique('network_diagnostics_monitor_region_kind_window_unique').on(
      table.monitorId,
      table.regionId,
      table.kind,
      table.windowStartedAt,
    ),
    check('network_diagnostics_dns_candidates_kind', sql`${table.kind} = 'dns_candidates'`),
    check(
      'network_diagnostics_lifecycle_result',
      sql`(${table.lifecycle} = 'complete' and ${table.result} is not null and ${table.completedAt} is not null) or (${table.lifecycle} = 'pending' and ${table.result} is null and ${table.completedAt} is null) or (${table.lifecycle} = 'unavailable' and ${table.result} is null and ${table.completedAt} is not null)`,
    ),
    check(
      'network_diagnostics_failure_code',
      sql`${table.failureCode} is null or ${table.failureCode} in ('worker_unsupported_or_missing', 'protocol_invalid_response', 'scheduler_abandoned')`,
    ),
    index('network_diagnostics_monitor_region_time_idx').on(
      table.monitorId,
      table.regionId,
      table.windowStartedAt,
    ),
    index('network_diagnostics_lifecycle_time_idx').on(table.lifecycle, table.requestedAt),
    index('network_diagnostics_created_at_idx').on(table.createdAt),
  ],
);
