import type { Badge, Observation, RegionId } from '@uptime/contracts';
import type { NotificationProviderKind } from '@uptime/contracts';

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
  notification_service_ids: string;
}

export interface BadgeRow {
  id: string;
  name: string;
  color: string;
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

export interface ObservationRow {
  id: string;
  check_run_id: string;
  monitor_id: string;
  region_id: RegionId;
  status: 'success' | 'http_failure' | 'network_failure';
  success: number;
  http_status: number | null;
  response_ms: number | null;
  total_ms: number | null;
  error_code: Observation['errorCode'];
  error_detail: string | null;
  placement: string | null;
  colo: string | null;
  final_url: string | null;
  endpoint_evidence: string | null;
  redirect_count: number | null;
  body_bytes: number | null;
  probe_version: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface DnsDiagnosticRow {
  id: string;
  monitor_id: string;
  check_run_id: string | null;
  observation_id: string | null;
  region_id: RegionId;
  kind: 'dns_candidates';
  window_started_at: string;
  lifecycle: 'pending' | 'complete' | 'unavailable';
  result: string | null;
  failure_code: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface StatusPageRow {
  id: string;
  title: string;
  public_slug: string | null;
  monitor_count?: number;
  created_at: string;
  updated_at: string;
}

export interface StatusPageGroupRow {
  id: string;
  title: string;
  position: number;
  width: 'full' | 'half';
  show_badges: number;
}

export interface StatusPageMonitorRow {
  group_id: string;
  id: string;
  name: string | null;
  url: string;
  public_slug: string | null;
  badge_id: string | null;
  badge_name: string | null;
  badge_color: string | null;
  uptime_thresholds: string;
  position: number;
}

export interface UptimeDayRow {
  monitor_id: string;
  day: string;
  uptime_percentage: number | null;
  average_response_ms: number | null;
  weight: number | null;
  received_count: number | null;
  success_count: number | null;
}

export function parseNotificationServiceIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseBadgeColumns(row: StatusPageMonitorRow): Badge | null {
  if (!row.badge_id || !row.badge_name || !row.badge_color) return null;
  return { id: row.badge_id, name: row.badge_name, color: row.badge_color };
}

export function parseUptimeThresholds(raw: string): {
  green: number;
  lightGreen: number;
  orange: number;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      green: Number(parsed.green ?? 99.5),
      lightGreen: Number(parsed.lightGreen ?? 99),
      orange: Number(parsed.orange ?? 90),
    };
  } catch {
    return { green: 99.5, lightGreen: 99, orange: 90 };
  }
}

export function asBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function asNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
