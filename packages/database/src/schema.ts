import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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
    outageThreshold: integer('outage_threshold').notNull().default(3),
    recoveryThreshold: integer('recovery_threshold').notNull().default(2),
    repeatNotificationMinutes: integer('repeat_notification_minutes'),
    dnsDiagnosticsEnabled: boolean('dns_diagnostics_enabled').notNull().default(false),
    isPublic: boolean('is_public').notNull().default(false),
    publicSlug: text('public_slug'),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('monitors_http_url', sql`${table.url} ~ '^https?://'`),
    check('monitors_outage_threshold_check', sql`${table.outageThreshold} between 1 and 100`),
    check('monitors_recovery_threshold_check', sql`${table.recoveryThreshold} between 1 and 100`),
    check(
      'monitors_repeat_notification_minutes_check',
      sql`${table.repeatNotificationMinutes} between 1 and 10080`,
    ),
    check(
      'monitors_public_slug_format',
      sql`${table.publicSlug} is null or (length(${table.publicSlug}) between 3 and 64 and ${table.publicSlug} ~ '^[a-z0-9]+([.-][a-z0-9]+)*$')`,
    ),
    unique('monitors_public_slug_unique').on(table.publicSlug),
    check(
      'monitors_interval_preset',
      sql`${table.intervalSeconds} in (60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600)`,
    ),
    check('monitors_timeout_range', sql`${table.timeoutMs} between 1000 and 30000`),
    check(
      'monitors_timeout_before_interval',
      sql`${table.timeoutMs} < ${table.intervalSeconds} * 1000`,
    ),
    index('monitors_due_idx').on(table.enabled, table.nextCheckAt),
  ],
);

/**
 * Finalized UTC-day availability. Imported history can set a dataset-specific
 * source and omit raw counts while retaining an explicit weighting.
 */
export const monitorDailyUptime = pgTable(
  'monitor_daily_uptime',
  {
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'date' }).notNull(),
    uptimePercentage: doublePrecision('uptime_percentage').notNull(),
    averageResponseMs: doublePrecision('average_response_ms'),
    weight: doublePrecision('weight').notNull().default(1),
    receivedCount: integer('received_count'),
    successCount: integer('success_count'),
    source: text('source').notNull().default('calculated'),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.day] }),
    check(
      'monitor_daily_uptime_percentage_range',
      sql`${table.uptimePercentage} between 0 and 100`,
    ),
    check(
      'monitor_daily_uptime_average_response_nonnegative',
      sql`${table.averageResponseMs} is null or ${table.averageResponseMs} >= 0`,
    ),
    check('monitor_daily_uptime_weight_positive', sql`${table.weight} > 0`),
    check(
      'monitor_daily_uptime_counts_consistent',
      sql`(${table.receivedCount} is null and ${table.successCount} is null) or (${table.receivedCount} > 0 and ${table.successCount} between 0 and ${table.receivedCount})`,
    ),
    index('monitor_daily_uptime_day_idx').on(table.day, table.monitorId),
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

export const statusPages = pgTable(
  'status_pages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: text('title').notNull(),
    publicSlug: text('public_slug'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'status_pages_public_slug_format',
      sql`${table.publicSlug} is null or (length(${table.publicSlug}) between 3 and 64 and ${table.publicSlug} ~ '^[a-z0-9]+([.-][a-z0-9]+)*$')`,
    ),
    unique('status_pages_public_slug_unique').on(table.publicSlug),
  ],
);

export const statusPageGroups = pgTable(
  'status_page_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    statusPageId: uuid('status_page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('status_page_groups_id_page_unique').on(table.id, table.statusPageId),
    unique('status_page_groups_page_position_unique').on(table.statusPageId, table.position),
    check('status_page_groups_position_nonnegative', sql`${table.position} >= 0`),
  ],
);

export const statusPageMonitors = pgTable(
  'status_page_monitors',
  {
    statusPageId: uuid('status_page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => statusPageGroups.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.statusPageId, table.monitorId] }),
    unique('status_page_monitors_group_position_unique').on(table.groupId, table.position),
    foreignKey({
      columns: [table.groupId, table.statusPageId],
      foreignColumns: [statusPageGroups.id, statusPageGroups.statusPageId],
      name: 'status_page_monitors_group_page_fk',
    }).onDelete('cascade'),
    check('status_page_monitors_position_nonnegative', sql`${table.position} >= 0`),
    index('status_page_monitors_monitor_idx').on(table.monitorId),
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

export const notificationServices = pgTable(
  'notification_services',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'notification_services_provider_check',
      sql`${table.provider} in ('telegram', 'discord', 'resend', 'gotify', 'webhook', 'smtp', 'home-assistant')`,
    ),
  ],
);

export const monitorNotificationServices = pgTable(
  'monitor_notification_services',
  {
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    notificationServiceId: uuid('notification_service_id')
      .notNull()
      .references(() => notificationServices.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.notificationServiceId] }),
    index('monitor_notification_services_service_idx').on(table.notificationServiceId),
  ],
);

export const monitorNotificationState = pgTable(
  'monitor_notification_state',
  {
    monitorId: uuid('monitor_id')
      .primaryKey()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    configFingerprint: text('config_fingerprint').notNull(),
    lastWindowStartedAt: timestamp('last_window_started_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('healthy'),
    failureStreak: integer('failure_streak').notNull().default(0),
    successStreak: integer('success_streak').notNull().default(0),
    outageStartedAt: timestamp('outage_started_at', { withTimezone: true }),
    lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('monitor_notification_state_status_check', sql`${table.status} in ('healthy', 'down')`),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    notificationServiceId: uuid('notification_service_id')
      .notNull()
      .references(() => notificationServices.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    kind: text('kind').notNull(),
    message: jsonb('message').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (table) => [
    unique('notification_deliveries_event_key_notification_service_id_key').on(
      table.eventKey,
      table.notificationServiceId,
    ),
    check(
      'notification_deliveries_kind_check',
      sql`${table.kind} in ('outage', 'recovery', 'reminder')`,
    ),
    check(
      'notification_deliveries_status_check',
      sql`${table.status} in ('pending', 'sending', 'sent', 'cancelled', 'failed')`,
    ),
    index('notification_deliveries_due_idx').on(table.status, table.nextAttemptAt),
    index('notification_deliveries_monitor_idx').on(table.monitorId),
  ],
);
