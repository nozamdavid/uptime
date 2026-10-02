import type { RegionId } from './regions.js';

/**
 * Contract enums mirrored from `@uptime/contracts`. They are re-declared here
 * so this package has no non-region workspace dependency and can be installed
 * without touching the root lockfile. Values are kept in sync with the
 * contracts package; the D1 CHECK constraints enforce the same sets.
 */
export type RunStatus = 'pending' | 'complete' | 'partial';
export type ObservationStatus = 'success' | 'http_failure' | 'network_failure';
export type ObservationErrorCode =
  | 'timeout'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'redirect_limit'
  | 'response_too_large'
  | 'invalid_response'
  | 'probe_rejected'
  | 'probe_unreachable'
  | 'unknown';
export type NotificationProviderKind =
  'telegram' | 'discord' | 'resend' | 'gotify' | 'webhook' | 'smtp' | 'home-assistant' | 'bluesky';
export type AggregateStatus = 'up' | 'degraded' | 'down' | 'unknown';

export interface NotificationMessage {
  kind: 'outage' | 'recovery' | 'reminder' | 'test';
  monitorName: string;
  monitorUrl: string;
  occurredAt: string;
  outageStartedAt: string | null;
}

/**
 * Raw D1 row shapes. D1 returns SQLite storage values: booleans come back as
 * `0|1`, timestamps as ISO text. `toBoolean` in `env.ts` and `parseJsonColumn`
 * below convert to the contract domain types.
 */
export interface MonitorRow {
  id: string;
  name: string | null;
  url: string;
  interval_seconds: number;
  timeout_ms: number;
  enabled: number;
  dns_diagnostics_enabled: number;
  is_public: number;
  public_slug: string | null;
  badge_id: string | null;
  uptime_thresholds: string;
  outage_threshold: number;
  recovery_threshold: number;
  repeat_notification_minutes: number | null;
  report_interval_seconds: number;
  next_check_at: string;
  created_at: string;
  updated_at: string;
}

export interface UptimeThresholdsRow {
  green: number;
  lightGreen: number;
  orange: number;
}

export interface MonitorRegionRow {
  monitor_id: string;
  region_id: RegionId;
  created_at: string;
}

export interface BadgeRow {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface AdminRow {
  id: string;
  singleton_key: number;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  admin_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
}

export interface CheckRunRow {
  id: string;
  monitor_id: string;
  window_started_at: string;
  status: RunStatus;
  expected_region_count: number;
  expected_regions: string;
  monitor_url: string;
  timeout_ms: number;
  dns_diagnostics_enabled: number;
  config_fingerprint: string | null;
  deadline_at: string;
  claim_token: string | null;
  claim_expires_at: string | null;
  claimed_by: string | null;
  created_at: string;
  completed_at: string | null;
  finalized_at: string | null;
}

export interface ObservationRow {
  id: string;
  check_run_id: string;
  monitor_id: string;
  region_id: RegionId;
  scheduled_window: string;
  status: ObservationStatus;
  success: number;
  http_status: number | null;
  response_ms: number | null;
  total_ms: number | null;
  error_code: ObservationErrorCode | null;
  error_detail: string | null;
  placement: string | null;
  colo: string | null;
  final_url: string | null;
  endpoint_evidence: string | null;
  redirect_count: number | null;
  body_bytes: number | null;
  probe_version: string | null;
  response_metadata: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface NetworkDiagnosticRow {
  id: string;
  monitor_id: string;
  check_run_id: string | null;
  observation_id: string | null;
  region_id: RegionId;
  kind: string;
  window_started_at: string;
  lifecycle: 'pending' | 'complete' | 'unavailable';
  result: string | null;
  failure_code: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface NotificationServiceRow {
  id: string;
  name: string;
  provider: NotificationProviderKind;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

export interface MonitorNotificationServiceRow {
  monitor_id: string;
  notification_service_id: string;
}

export interface MonitorNotificationStateRow {
  monitor_id: string;
  config_fingerprint: string;
  last_window_started_at: string;
  status: 'healthy' | 'down';
  failure_streak: number;
  success_streak: number;
  outage_started_at: string | null;
  last_reminder_at: string | null;
  updated_at: string;
}

export interface NotificationDeliveryRow {
  id: string;
  monitor_id: string;
  notification_service_id: string;
  event_key: string;
  kind: 'outage' | 'recovery' | 'reminder';
  message: string;
  status: 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  lease_token: string | null;
  created_at: string;
  sent_at: string | null;
  last_error: string | null;
}

export interface MonitorDailyUptimeRow {
  monitor_id: string;
  day: string;
  uptime_percentage: number;
  average_response_ms: number | null;
  weight: number;
  received_count: number | null;
  success_count: number | null;
  response_sum_ms: number;
  response_count_ms: number;
  source: string;
  finalized_at: string;
  created_at: string;
  updated_at: string;
}

export interface StatusPageRow {
  id: string;
  title: string;
  public_slug: string | null;
  report_interval_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface StatusPageGroupRow {
  id: string;
  status_page_id: string;
  title: string;
  position: number;
  width: 'full' | 'half';
  show_badges: number;
  created_at: string;
}

export interface StatusPageMonitorRow {
  status_page_id: string;
  group_id: string;
  monitor_id: string;
  position: number;
  created_at: string;
}

export interface JobRow {
  name: string;
  lease_token: string | null;
  lease_until: string | null;
  cursor: string | null;
  state_json: string | null;
  last_started_at: string | null;
  last_completed_at: string | null;
  updated_at: string;
}

export type ReportPublicationKind = 'status-page' | 'monitor' | 'index';

export interface ReportPublicationRow {
  report_key: string;
  kind: ReportPublicationKind;
  status_page_id: string | null;
  monitor_id: string | null;
  object_key: string;
  schema_version: string;
  generation: number;
  generated_at: string | null;
  latest_observation_at: string | null;
  source_watermark: string | null;
  status: 'pending' | 'complete' | 'failed';
  attempts: number;
  last_error: string | null;
  lease_until: string | null;
  lease_token: string | null;
  updated_at: string;
}

export interface DueRound {
  id: string;
  monitorId: string;
  monitorUrl: string;
  timeoutMs: number;
  windowStartedAt: string;
  dnsDiagnosticsEnabled: boolean;
  regionIds: RegionId[];
}

/** Aggregate status derived from a round's regional observations. */
export interface RoundSummary {
  monitorId: string;
  windowStartedAt: string;
  expectedRegionCount: number;
  receivedCount: number;
  successCount: number;
  failureCount: number;
  status: RunStatus;
}

export type { RegionId };
