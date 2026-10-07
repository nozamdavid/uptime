-- Tenant migration 0001: Initial schema
-- Tables (18): admins, sessions, badges, monitors, status_pages, status_page_groups,
-- status_page_monitors, monitor_regions, check_runs, observations,
-- network_diagnostics, notification_services, monitor_notification_services,
-- monitor_notification_state, notification_deliveries, monitor_daily_uptime,
-- jobs, report_publications.
-- Triggers: check_runs_finalize_aggregate, observations_accumulate_finalized (with MVCC locking)

CREATE TABLE IF NOT EXISTS {{schema}}.admins (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  singleton_key INTEGER NOT NULL DEFAULT 1 CONSTRAINT admins_singleton_key_unique UNIQUE CONSTRAINT admins_singleton_key_true CHECK (singleton_key = 1),
  email TEXT NOT NULL CONSTRAINT admins_email_unique UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS {{schema}}.sessions (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  admin_id TEXT NOT NULL REFERENCES {{schema}}.admins (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL CONSTRAINT sessions_token_hash_unique UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  last_seen_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS sessions_admin_expires_idx ON {{schema}}.sessions (admin_id, expires_at);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON {{schema}}.sessions (expires_at);

CREATE TABLE IF NOT EXISTS {{schema}}.badges (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL CONSTRAINT badges_name_not_blank CHECK (length(trim(name)) BETWEEN 1 AND 40),
  color TEXT NOT NULL CONSTRAINT badges_color_hex CHECK (length(color) = 7 AND substr(color, 1, 1) = '#' AND color ~ '^#[0-9a-fA-F]{6}$'),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE UNIQUE INDEX IF NOT EXISTS badges_name_unique ON {{schema}}.badges (lower(name));

CREATE TABLE IF NOT EXISTS {{schema}}.monitors (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  name TEXT,
  url TEXT NOT NULL CONSTRAINT monitors_http_url CHECK (url LIKE 'http://%' OR url LIKE 'https://%'),
  interval_seconds INTEGER NOT NULL CONSTRAINT monitors_interval_preset CHECK (interval_seconds IN (60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600)),
  timeout_ms INTEGER NOT NULL CONSTRAINT monitors_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 30000) CONSTRAINT monitors_timeout_before_interval CHECK (timeout_ms < interval_seconds * 1000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  dns_diagnostics_enabled INTEGER NOT NULL DEFAULT 0 CHECK (dns_diagnostics_enabled IN (0, 1)),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  public_slug TEXT CONSTRAINT monitors_public_slug_unique UNIQUE CONSTRAINT monitors_public_slug_format CHECK (
    public_slug IS NULL OR (
      length(public_slug) BETWEEN 3 AND 64
      AND public_slug ~ '^[a-z0-9]'
      AND public_slug ~ '[a-z0-9]$'
      AND public_slug ~ '^[a-z0-9.-]+$'
      AND public_slug !~ '[.-]{2}'
    )
  ),
  badge_id TEXT REFERENCES {{schema}}.badges (id) ON DELETE SET NULL,
  uptime_thresholds TEXT NOT NULL DEFAULT '{"green":99.5,"lightGreen":99,"orange":90}' CONSTRAINT monitors_uptime_thresholds_json CHECK (uptime_thresholds IS JSON),
  outage_threshold INTEGER NOT NULL DEFAULT 3 CONSTRAINT monitors_outage_threshold_check CHECK (outage_threshold BETWEEN 1 AND 100),
  recovery_threshold INTEGER NOT NULL DEFAULT 2 CONSTRAINT monitors_recovery_threshold_check CHECK (recovery_threshold BETWEEN 1 AND 100),
  repeat_notification_minutes INTEGER CONSTRAINT monitors_repeat_notification_minutes_check CHECK (repeat_notification_minutes IS NULL OR repeat_notification_minutes BETWEEN 1 AND 10080),
  report_interval_seconds INTEGER NOT NULL DEFAULT 60 CONSTRAINT monitors_report_interval_check CHECK (report_interval_seconds BETWEEN 60 AND 86400),
  next_check_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS monitors_due_idx ON {{schema}}.monitors (enabled, next_check_at);

CREATE TABLE IF NOT EXISTS {{schema}}.status_pages (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  title TEXT NOT NULL,
  public_slug TEXT CONSTRAINT status_pages_public_slug_unique UNIQUE CONSTRAINT status_pages_public_slug_format CHECK (
    public_slug IS NULL OR (
      length(public_slug) BETWEEN 3 AND 64
      AND public_slug ~ '^[a-z0-9]'
      AND public_slug ~ '[a-z0-9]$'
      AND public_slug ~ '^[a-z0-9.-]+$'
      AND public_slug !~ '[.-]{2}'
    )
  ),
  report_interval_seconds INTEGER NOT NULL DEFAULT 60 CONSTRAINT status_pages_report_interval_check CHECK (report_interval_seconds BETWEEN 60 AND 86400),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS {{schema}}.status_page_groups (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  status_page_id TEXT NOT NULL REFERENCES {{schema}}.status_pages (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CONSTRAINT status_page_groups_position_nonnegative CHECK (position >= 0),
  width TEXT NOT NULL DEFAULT 'full' CONSTRAINT status_page_groups_width CHECK (width IN ('full', 'half')),
  show_badges INTEGER NOT NULL DEFAULT 1 CHECK (show_badges IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  CONSTRAINT status_page_groups_page_position_unique UNIQUE (status_page_id, position),
  CONSTRAINT status_page_groups_id_page_unique UNIQUE (id, status_page_id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.status_page_monitors (
  status_page_id TEXT NOT NULL REFERENCES {{schema}}.status_pages (id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CONSTRAINT status_page_monitors_position_nonnegative CHECK (position >= 0),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (status_page_id, monitor_id),
  CONSTRAINT status_page_monitors_group_position_unique UNIQUE (group_id, position),
  CONSTRAINT status_page_monitors_group_page_fk FOREIGN KEY (group_id, status_page_id) REFERENCES {{schema}}.status_page_groups (id, status_page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS status_page_monitors_monitor_idx ON {{schema}}.status_page_monitors (monitor_id);

CREATE TABLE IF NOT EXISTS {{schema}}.monitor_regions (
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  region_id TEXT NOT NULL CONSTRAINT monitor_regions_region_check CHECK (region_id IN ('us-east', 'us-west', 'canada-central', 'eu-west', 'eu-north', 'eu-south', 'asia', 'asia-east', 'asia-south')),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (monitor_id, region_id)
);

CREATE INDEX IF NOT EXISTS monitor_regions_region_idx ON {{schema}}.monitor_regions (region_id, monitor_id);

CREATE TABLE IF NOT EXISTS {{schema}}.check_runs (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  window_started_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT check_runs_status CHECK (status IN ('pending', 'complete', 'partial')),
  expected_region_count INTEGER NOT NULL CONSTRAINT check_runs_region_count CHECK (expected_region_count BETWEEN 1 AND 9),
  expected_regions TEXT NOT NULL DEFAULT '[]' CONSTRAINT check_runs_expected_regions_json CHECK (expected_regions IS JSON),
  monitor_url TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CONSTRAINT check_runs_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 30000),
  dns_diagnostics_enabled INTEGER NOT NULL DEFAULT 0 CHECK (dns_diagnostics_enabled IN (0, 1)),
  config_fingerprint TEXT,
  deadline_at TEXT NOT NULL,
  claim_token TEXT,
  claim_expires_at TEXT,
  claimed_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  completed_at TEXT,
  finalized_at TEXT,
  CONSTRAINT check_runs_monitor_window_unique UNIQUE (monitor_id, window_started_at),
  CONSTRAINT check_runs_id_monitor_unique UNIQUE (id, monitor_id)
);

CREATE INDEX IF NOT EXISTS check_runs_monitor_time_idx ON {{schema}}.check_runs (monitor_id, window_started_at);
CREATE INDEX IF NOT EXISTS check_runs_status_time_idx ON {{schema}}.check_runs (status, window_started_at);
CREATE INDEX IF NOT EXISTS check_runs_pending_claim_idx ON {{schema}}.check_runs (status, claim_expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS check_runs_pending_deadline_idx ON {{schema}}.check_runs (status, deadline_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS {{schema}}.observations (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  check_run_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  region_id TEXT NOT NULL CONSTRAINT observations_region_check CHECK (region_id IN ('us-east', 'us-west', 'canada-central', 'eu-west', 'eu-north', 'eu-south', 'asia', 'asia-east', 'asia-south')),
  scheduled_window TEXT NOT NULL,
  status TEXT NOT NULL CONSTRAINT observations_status CHECK (status IN ('success', 'http_failure', 'network_failure')),
  success INTEGER NOT NULL CHECK (success IN (0, 1)) CONSTRAINT observations_success_consistent CHECK ((success = 1 AND status = 'success') OR (success = 0 AND status <> 'success')),
  http_status INTEGER CONSTRAINT observations_http_status_range CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  response_ms REAL CONSTRAINT observations_response_ms_nonnegative CHECK (response_ms IS NULL OR response_ms >= 0),
  total_ms REAL CONSTRAINT observations_total_ms_nonnegative CHECK (total_ms IS NULL OR total_ms >= 0),
  error_code TEXT,
  error_detail TEXT,
  placement TEXT,
  colo TEXT,
  final_url TEXT,
  endpoint_evidence TEXT CONSTRAINT observations_endpoint_evidence_json CHECK (endpoint_evidence IS NULL OR endpoint_evidence IS JSON),
  redirect_count INTEGER CONSTRAINT observations_redirect_range CHECK (redirect_count IS NULL OR redirect_count BETWEEN 0 AND 5),
  body_bytes INTEGER CONSTRAINT observations_body_bytes_nonnegative CHECK (body_bytes IS NULL OR body_bytes >= 0),
  probe_version TEXT,
  response_metadata TEXT CONSTRAINT observations_response_metadata_json CHECK (response_metadata IS NULL OR response_metadata IS JSON),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  CONSTRAINT observations_run_monitor_fk FOREIGN KEY (check_run_id, monitor_id) REFERENCES {{schema}}.check_runs (id, monitor_id) ON DELETE CASCADE,
  CONSTRAINT observations_monitor_region_window_unique UNIQUE (monitor_id, region_id, scheduled_window),
  CONSTRAINT observations_run_region_unique UNIQUE (check_run_id, region_id)
);

CREATE INDEX IF NOT EXISTS observations_created_at_idx ON {{schema}}.observations (created_at);

CREATE TABLE IF NOT EXISTS {{schema}}.network_diagnostics (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  check_run_id TEXT,
  observation_id TEXT REFERENCES {{schema}}.observations (id) ON DELETE SET NULL,
  region_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dns_candidates' CONSTRAINT network_diagnostics_kind CHECK (kind = 'dns_candidates'),
  window_started_at TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'pending' CONSTRAINT network_diagnostics_lifecycle CHECK (lifecycle IN ('pending', 'complete', 'unavailable')),
  result TEXT CONSTRAINT network_diagnostics_result_json CHECK (result IS NULL OR result IS JSON),
  failure_code TEXT CONSTRAINT network_diagnostics_failure_code CHECK (failure_code IS NULL OR failure_code IN ('worker_unsupported_or_missing', 'protocol_invalid_response', 'scheduler_abandoned')),
  requested_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  CONSTRAINT network_diagnostics_lifecycle_result CHECK ((lifecycle = 'complete' AND result IS NOT NULL AND completed_at IS NOT NULL) OR (lifecycle = 'pending' AND result IS NULL AND completed_at IS NULL) OR (lifecycle = 'unavailable' AND result IS NULL AND completed_at IS NOT NULL)),
  CONSTRAINT network_diagnostics_monitor_region_kind_window_unique UNIQUE (monitor_id, region_id, kind, window_started_at)
);

CREATE INDEX IF NOT EXISTS network_diagnostics_monitor_region_time_idx ON {{schema}}.network_diagnostics (monitor_id, region_id, window_started_at);
CREATE INDEX IF NOT EXISTS network_diagnostics_lifecycle_time_idx ON {{schema}}.network_diagnostics (lifecycle, requested_at);
CREATE INDEX IF NOT EXISTS network_diagnostics_created_at_idx ON {{schema}}.network_diagnostics (created_at);

CREATE TABLE IF NOT EXISTS {{schema}}.notification_services (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CONSTRAINT notification_services_provider_check CHECK (provider IN ('telegram', 'discord', 'resend', 'gotify', 'webhook', 'smtp', 'home-assistant')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config TEXT NOT NULL CONSTRAINT notification_services_config_json CHECK (config IS JSON),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS {{schema}}.monitor_notification_services (
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  notification_service_id TEXT NOT NULL REFERENCES {{schema}}.notification_services (id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, notification_service_id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.monitor_notification_state (
  monitor_id TEXT PRIMARY KEY NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  config_fingerprint TEXT NOT NULL,
  last_window_started_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy' CONSTRAINT monitor_notification_state_status CHECK (status IN ('healthy', 'down')),
  failure_streak INTEGER NOT NULL DEFAULT 0,
  success_streak INTEGER NOT NULL DEFAULT 0,
  outage_started_at TEXT,
  last_reminder_at TEXT,
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS {{schema}}.notification_deliveries (
  id TEXT PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::text,
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  notification_service_id TEXT NOT NULL REFERENCES {{schema}}.notification_services (id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL CONSTRAINT notification_deliveries_kind CHECK (kind IN ('outage', 'recovery', 'reminder')),
  message TEXT NOT NULL CONSTRAINT notification_deliveries_message_json CHECK (message IS JSON),
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT notification_deliveries_status CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  lease_until TEXT,
  lease_token TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  sent_at TEXT,
  last_error TEXT,
  CONSTRAINT notification_deliveries_event_key_service_unique UNIQUE (event_key, notification_service_id)
);

CREATE INDEX IF NOT EXISTS notification_deliveries_monitor_idx ON {{schema}}.notification_deliveries (monitor_id);

CREATE TABLE IF NOT EXISTS {{schema}}.monitor_daily_uptime (
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors (id) ON DELETE CASCADE,
  day TEXT NOT NULL CONSTRAINT monitor_daily_uptime_day_format CHECK (length(day) = 10 AND day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  uptime_percentage REAL NOT NULL CONSTRAINT monitor_daily_uptime_percentage_range CHECK (uptime_percentage BETWEEN 0 AND 100),
  average_response_ms REAL CONSTRAINT monitor_daily_uptime_average_response_nonnegative CHECK (average_response_ms IS NULL OR average_response_ms >= 0),
  weight REAL NOT NULL DEFAULT 1 CONSTRAINT monitor_daily_uptime_weight_positive CHECK (weight > 0),
  received_count INTEGER,
  success_count INTEGER,
  response_sum_ms REAL NOT NULL DEFAULT 0 CONSTRAINT monitor_daily_uptime_response_sum_nonnegative CHECK (response_sum_ms >= 0),
  response_count_ms INTEGER NOT NULL DEFAULT 0 CONSTRAINT monitor_daily_uptime_response_count_nonnegative CHECK (response_count_ms >= 0),
  source TEXT NOT NULL DEFAULT 'calculated',
  finalized_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (monitor_id, day),
  CONSTRAINT monitor_daily_uptime_counts_consistent CHECK ((received_count IS NULL AND success_count IS NULL) OR (received_count > 0 AND success_count BETWEEN 0 AND received_count))
);

CREATE INDEX IF NOT EXISTS monitor_daily_uptime_day_idx ON {{schema}}.monitor_daily_uptime (day, monitor_id);

CREATE TABLE IF NOT EXISTS {{schema}}.jobs (
  name TEXT PRIMARY KEY NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  cursor TEXT CONSTRAINT jobs_cursor_json CHECK (cursor IS NULL OR cursor IS JSON),
  state_json TEXT CONSTRAINT jobs_state_json CHECK (state_json IS NULL OR state_json IS JSON),
  last_started_at TEXT,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS {{schema}}.report_publications (
  report_key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CONSTRAINT report_publications_kind CHECK (kind IN ('status-page', 'monitor', 'index')),
  status_page_id TEXT REFERENCES {{schema}}.status_pages (id) ON DELETE SET NULL,
  monitor_id TEXT REFERENCES {{schema}}.monitors (id) ON DELETE SET NULL,
  object_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0,
  generated_at TEXT,
  latest_observation_at TEXT,
  source_watermark TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT report_publications_status CHECK (status IN ('pending', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_until TEXT,
  lease_token TEXT,
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS report_publications_status_idx ON {{schema}}.report_publications (status, updated_at);
CREATE INDEX IF NOT EXISTS report_publications_status_page_idx ON {{schema}}.report_publications (status_page_id);
CREATE INDEX IF NOT EXISTS report_publications_monitor_idx ON {{schema}}.report_publications (monitor_id);

-- Writers use READ COMMITTED and lock the run in a separate statement before
-- finalization. Observation locking happens before FK checks acquire key-share.

CREATE OR REPLACE FUNCTION {{schema}}.observations_lock_run_func()
RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM {{schema}}.check_runs WHERE id = NEW.check_run_id FOR NO KEY UPDATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER observations_lock_run
BEFORE INSERT ON {{schema}}.observations
FOR EACH ROW EXECUTE FUNCTION {{schema}}.observations_lock_run_func();

CREATE OR REPLACE FUNCTION {{schema}}.check_runs_finalize_aggregate_func()
RETURNS trigger AS $$
DECLARE
  v_now TEXT;
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('complete', 'partial') THEN
    v_now := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

    INSERT INTO {{schema}}.monitor_daily_uptime (
      monitor_id, day, uptime_percentage, average_response_ms, weight,
      received_count, success_count, response_sum_ms, response_count_ms,
      source, finalized_at, created_at, updated_at
    )
    SELECT
      NEW.monitor_id,
      substr(NEW.window_started_at, 1, 10),
      (sum(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) * 100.0) / count(*),
      CASE
        WHEN sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN 1 ELSE 0 END) > 0
        THEN sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN o.response_ms ELSE 0 END) * 1.0
          / sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN 1 ELSE 0 END)
        ELSE NULL
      END,
      count(*),
      count(*),
      sum(CASE WHEN o.success = 1 THEN 1 ELSE 0 END),
      sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN o.response_ms ELSE 0 END),
      sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN 1 ELSE 0 END),
      'calculated',
      v_now,
      v_now,
      v_now
    FROM {{schema}}.observations o
    WHERE o.check_run_id = NEW.id
    GROUP BY NEW.monitor_id
    HAVING count(*) > 0
    ON CONFLICT (monitor_id, day) DO UPDATE SET
      received_count = {{schema}}.monitor_daily_uptime.received_count + EXCLUDED.received_count,
      success_count = {{schema}}.monitor_daily_uptime.success_count + EXCLUDED.success_count,
      response_sum_ms = {{schema}}.monitor_daily_uptime.response_sum_ms + EXCLUDED.response_sum_ms,
      response_count_ms = {{schema}}.monitor_daily_uptime.response_count_ms + EXCLUDED.response_count_ms,
      uptime_percentage = (
        ({{schema}}.monitor_daily_uptime.success_count + EXCLUDED.success_count) * 100.0
      ) / ({{schema}}.monitor_daily_uptime.received_count + EXCLUDED.received_count),
      average_response_ms = CASE
        WHEN ({{schema}}.monitor_daily_uptime.response_count_ms + EXCLUDED.response_count_ms) > 0
        THEN ({{schema}}.monitor_daily_uptime.response_sum_ms + EXCLUDED.response_sum_ms) * 1.0
          / ({{schema}}.monitor_daily_uptime.response_count_ms + EXCLUDED.response_count_ms)
        ELSE NULL
      END,
      weight = {{schema}}.monitor_daily_uptime.received_count + EXCLUDED.received_count,
      finalized_at = EXCLUDED.finalized_at,
      updated_at = EXCLUDED.updated_at
    WHERE {{schema}}.monitor_daily_uptime.source = 'calculated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER check_runs_finalize_aggregate
AFTER UPDATE OF status ON {{schema}}.check_runs
FOR EACH ROW EXECUTE FUNCTION {{schema}}.check_runs_finalize_aggregate_func();

CREATE OR REPLACE FUNCTION {{schema}}.observations_accumulate_finalized_func()
RETURNS trigger AS $$
DECLARE
  v_status TEXT;
  v_now TEXT;
BEGIN
  -- BEFORE INSERT already holds the run lock, before FK key-share acquisition.
  SELECT status INTO v_status
    FROM {{schema}}.check_runs
   WHERE id = NEW.check_run_id
     FOR NO KEY UPDATE;

  IF v_status IN ('complete', 'partial') THEN
    v_now := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

    INSERT INTO {{schema}}.monitor_daily_uptime (
      monitor_id, day, uptime_percentage, average_response_ms, weight,
      received_count, success_count, response_sum_ms, response_count_ms,
      source, finalized_at, created_at, updated_at
    )
    VALUES (
      NEW.monitor_id,
      substr(NEW.scheduled_window, 1, 10),
      CASE WHEN NEW.success = 1 THEN 100.0 ELSE 0.0 END,
      CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN NEW.response_ms ELSE NULL END,
      1,
      1,
      CASE WHEN NEW.success = 1 THEN 1 ELSE 0 END,
      CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN NEW.response_ms ELSE 0 END,
      CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN 1 ELSE 0 END,
      'calculated',
      v_now,
      v_now,
      v_now
    )
    ON CONFLICT (monitor_id, day) DO UPDATE SET
      received_count = {{schema}}.monitor_daily_uptime.received_count + 1,
      success_count = {{schema}}.monitor_daily_uptime.success_count
        + CASE WHEN EXCLUDED.success_count = 1 THEN 1 ELSE 0 END,
      response_sum_ms = {{schema}}.monitor_daily_uptime.response_sum_ms
        + EXCLUDED.response_sum_ms,
      response_count_ms = {{schema}}.monitor_daily_uptime.response_count_ms
        + EXCLUDED.response_count_ms,
      uptime_percentage = (
        ({{schema}}.monitor_daily_uptime.success_count + CASE WHEN EXCLUDED.success_count = 1 THEN 1 ELSE 0 END) * 100.0
      ) / ({{schema}}.monitor_daily_uptime.received_count + 1),
      average_response_ms = CASE
        WHEN ({{schema}}.monitor_daily_uptime.response_count_ms + EXCLUDED.response_count_ms) > 0
        THEN ({{schema}}.monitor_daily_uptime.response_sum_ms + EXCLUDED.response_sum_ms) * 1.0
          / ({{schema}}.monitor_daily_uptime.response_count_ms + EXCLUDED.response_count_ms)
        ELSE NULL
      END,
      weight = {{schema}}.monitor_daily_uptime.received_count + 1,
      finalized_at = v_now,
      updated_at = v_now
    WHERE {{schema}}.monitor_daily_uptime.source = 'calculated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER observations_accumulate_finalized
AFTER INSERT ON {{schema}}.observations
FOR EACH ROW EXECUTE FUNCTION {{schema}}.observations_accumulate_finalized_func();
