-- @uptime/cloudflare D1 schema (SQLite dialect).
--
-- Conventions:
--   * ids are UUIDv4 text produced by a SQLite default expression or app code.
--   * timestamps are ISO-8601 UTC text with milliseconds: 2026-09-20T18:40:00.000Z.
--   * booleans are INTEGER 0/1 with CHECK constraints.
--   * JSON columns are TEXT with CHECK (json_valid(col)).
--
-- D1 applies each migration in a transaction and records it in d1_migrations.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Authentication
-- ---------------------------------------------------------------------------

CREATE TABLE admins (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  singleton_key INTEGER NOT NULL DEFAULT 1,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT admins_singleton_key_unique UNIQUE (singleton_key),
  CONSTRAINT admins_email_unique UNIQUE (email),
  CONSTRAINT admins_singleton_key_true CHECK (singleton_key = 1)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  admin_id TEXT NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX sessions_admin_expires_idx ON sessions (admin_id, expires_at);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Display
-- ---------------------------------------------------------------------------

CREATE TABLE badges (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT badges_name_not_blank CHECK (length(trim(name)) BETWEEN 1 AND 40),
  CONSTRAINT badges_color_hex CHECK (
    length(color) = 7 AND substr(color, 1, 1) = '#'
      AND substr(color, 2) NOT GLOB '*[^0-9a-fA-F]*'
  )
);

CREATE UNIQUE INDEX badges_name_unique ON badges (lower(name));

-- ---------------------------------------------------------------------------
-- Monitors
-- ---------------------------------------------------------------------------

CREATE TABLE monitors (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  name TEXT,
  url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  dns_diagnostics_enabled INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  public_slug TEXT,
  badge_id TEXT REFERENCES badges (id) ON DELETE SET NULL,
  uptime_thresholds TEXT NOT NULL DEFAULT '{"green":99.5,"lightGreen":99,"orange":90}',
  outage_threshold INTEGER NOT NULL DEFAULT 3,
  recovery_threshold INTEGER NOT NULL DEFAULT 2,
  repeat_notification_minutes INTEGER,
  report_interval_seconds INTEGER NOT NULL DEFAULT 60,
  next_check_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT monitors_http_url CHECK (url GLOB 'http://*' OR url GLOB 'https://*'),
  CONSTRAINT monitors_interval_preset CHECK (
    interval_seconds IN (60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900,
      1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600)
  ),
  CONSTRAINT monitors_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 30000),
  CONSTRAINT monitors_timeout_before_interval CHECK (timeout_ms < interval_seconds * 1000),
  CONSTRAINT monitors_uptime_thresholds_json CHECK (json_valid(uptime_thresholds)),
  CONSTRAINT monitors_outage_threshold_check CHECK (outage_threshold BETWEEN 1 AND 100),
  CONSTRAINT monitors_recovery_threshold_check CHECK (recovery_threshold BETWEEN 1 AND 100),
  CONSTRAINT monitors_repeat_notification_minutes_check CHECK (
    repeat_notification_minutes IS NULL OR repeat_notification_minutes BETWEEN 1 AND 10080
  ),
  CONSTRAINT monitors_report_interval_check CHECK (report_interval_seconds BETWEEN 60 AND 86400),
  CONSTRAINT monitors_public_slug_format CHECK (
    public_slug IS NULL OR (
      length(public_slug) BETWEEN 3 AND 64
      AND public_slug NOT GLOB '*[^a-z0-9.-]*'
      AND public_slug GLOB '[a-z0-9]*'
      AND public_slug GLOB '*[a-z0-9]'
      AND public_slug NOT GLOB '*[.-][.-]*'
    )
  ),
  CONSTRAINT monitors_public_slug_unique UNIQUE (public_slug)
);

CREATE INDEX monitors_due_idx ON monitors (enabled, next_check_at);

-- ---------------------------------------------------------------------------
-- Status pages
-- ---------------------------------------------------------------------------

CREATE TABLE status_pages (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  title TEXT NOT NULL,
  public_slug TEXT,
  report_interval_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT status_pages_report_interval_check CHECK (report_interval_seconds BETWEEN 60 AND 86400),
  CONSTRAINT status_pages_public_slug_format CHECK (
    public_slug IS NULL OR (
      length(public_slug) BETWEEN 3 AND 64
      AND public_slug NOT GLOB '*[^a-z0-9.-]*'
      AND public_slug GLOB '[a-z0-9]*'
      AND public_slug GLOB '*[a-z0-9]'
      AND public_slug NOT GLOB '*[.-][.-]*'
    )
  ),
  CONSTRAINT status_pages_public_slug_unique UNIQUE (public_slug)
);

CREATE TABLE status_page_groups (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  status_page_id TEXT NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  width TEXT NOT NULL DEFAULT 'full',
  show_badges INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT status_page_groups_position_nonnegative CHECK (position >= 0),
  CONSTRAINT status_page_groups_width CHECK (width IN ('full', 'half')),
  CONSTRAINT status_page_groups_page_position_unique UNIQUE (status_page_id, position),
  CONSTRAINT status_page_groups_id_page_unique UNIQUE (id, status_page_id)
);

CREATE TABLE status_page_monitors (
  status_page_id TEXT NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (status_page_id, monitor_id),
  CONSTRAINT status_page_monitors_position_nonnegative CHECK (position >= 0),
  CONSTRAINT status_page_monitors_group_position_unique UNIQUE (group_id, position),
  CONSTRAINT status_page_monitors_group_page_fk FOREIGN KEY (group_id, status_page_id)
    REFERENCES status_page_groups (id, status_page_id) ON DELETE CASCADE
);

CREATE INDEX status_page_monitors_monitor_idx ON status_page_monitors (monitor_id);

-- ---------------------------------------------------------------------------
-- Regions
-- ---------------------------------------------------------------------------

CREATE TABLE monitor_regions (
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  region_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (monitor_id, region_id),
  CONSTRAINT monitor_regions_region_check CHECK (
    region_id IN (
      'us-east', 'us-west', 'canada-central', 'eu-west', 'eu-north', 'eu-south',
      'asia', 'asia-east', 'asia-south'
    )
  )
);

CREATE INDEX monitor_regions_region_idx ON monitor_regions (region_id, monitor_id);

-- ---------------------------------------------------------------------------
-- Check rounds
-- ---------------------------------------------------------------------------

CREATE TABLE check_runs (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  window_started_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expected_region_count INTEGER NOT NULL,
  expected_regions TEXT NOT NULL DEFAULT '[]',
  monitor_url TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  dns_diagnostics_enabled INTEGER NOT NULL DEFAULT 0,
  config_fingerprint TEXT,
  deadline_at TEXT NOT NULL,
  claim_token TEXT,
  claim_expires_at TEXT,
  claimed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  finalized_at TEXT,
  CONSTRAINT check_runs_status CHECK (status IN ('pending', 'complete', 'partial')),
  CONSTRAINT check_runs_region_count CHECK (expected_region_count BETWEEN 1 AND 9),
  CONSTRAINT check_runs_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 30000),
  CONSTRAINT check_runs_expected_regions_json CHECK (json_valid(expected_regions)),
  CONSTRAINT check_runs_monitor_window_unique UNIQUE (monitor_id, window_started_at),
  CONSTRAINT check_runs_id_monitor_unique UNIQUE (id, monitor_id)
);

CREATE INDEX check_runs_monitor_time_idx ON check_runs (monitor_id, window_started_at);
CREATE INDEX check_runs_status_time_idx ON check_runs (status, window_started_at);
CREATE INDEX check_runs_pending_claim_idx ON check_runs (status, claim_expires_at)
  WHERE status = 'pending';
CREATE INDEX check_runs_pending_deadline_idx ON check_runs (status, deadline_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------

CREATE TABLE observations (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  check_run_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  scheduled_window TEXT NOT NULL,
  status TEXT NOT NULL,
  success INTEGER NOT NULL,
  http_status INTEGER,
  response_ms REAL,
  total_ms REAL,
  error_code TEXT,
  error_detail TEXT,
  placement TEXT,
  colo TEXT,
  final_url TEXT,
  endpoint_evidence TEXT,
  redirect_count INTEGER,
  body_bytes INTEGER,
  probe_version TEXT,
  response_metadata TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT observations_run_monitor_fk FOREIGN KEY (check_run_id, monitor_id)
    REFERENCES check_runs (id, monitor_id) ON DELETE CASCADE,
  CONSTRAINT observations_status CHECK (status IN ('success', 'http_failure', 'network_failure')),
  CONSTRAINT observations_success_consistent CHECK (
    (success = 1 AND status = 'success') OR (success = 0 AND status <> 'success')
  ),
  CONSTRAINT observations_http_status_range CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT observations_nonnegative_timings CHECK (
    (response_ms IS NULL OR response_ms >= 0) AND (total_ms IS NULL OR total_ms >= 0)
  ),
  CONSTRAINT observations_redirect_range CHECK (redirect_count IS NULL OR redirect_count BETWEEN 0 AND 5),
  CONSTRAINT observations_body_bytes_nonnegative CHECK (body_bytes IS NULL OR body_bytes >= 0),
  CONSTRAINT observations_endpoint_evidence_json CHECK (
    endpoint_evidence IS NULL OR json_valid(endpoint_evidence)
  ),
  CONSTRAINT observations_response_metadata_json CHECK (
    response_metadata IS NULL OR json_valid(response_metadata)
  ),
  CONSTRAINT observations_region_check CHECK (
    region_id IN (
      'us-east', 'us-west', 'canada-central', 'eu-west', 'eu-north', 'eu-south',
      'asia', 'asia-east', 'asia-south'
    )
  ),
  -- Durable identity: a retried/duplicate observation for the same region and
  -- scheduled window can never be counted twice.
  CONSTRAINT observations_monitor_region_window_unique UNIQUE (monitor_id, region_id, scheduled_window),
  CONSTRAINT observations_run_region_unique UNIQUE (check_run_id, region_id)
);

CREATE INDEX observations_check_run_idx ON observations (check_run_id);
CREATE INDEX observations_monitor_time_idx ON observations (monitor_id, started_at);
CREATE INDEX observations_monitor_region_time_idx ON observations (monitor_id, region_id, started_at);
CREATE INDEX observations_error_time_idx ON observations (error_code, started_at);
CREATE INDEX observations_created_at_idx ON observations (created_at);

-- ---------------------------------------------------------------------------
-- Network diagnostics
-- ---------------------------------------------------------------------------

CREATE TABLE network_diagnostics (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  check_run_id TEXT,
  observation_id TEXT REFERENCES observations (id) ON DELETE SET NULL,
  region_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dns_candidates',
  window_started_at TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  failure_code TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT network_diagnostics_kind CHECK (kind = 'dns_candidates'),
  CONSTRAINT network_diagnostics_lifecycle CHECK (
    lifecycle IN ('pending', 'complete', 'unavailable')
  ),
  CONSTRAINT network_diagnostics_lifecycle_result CHECK (
    (lifecycle = 'complete' AND result IS NOT NULL AND completed_at IS NOT NULL)
    OR (lifecycle = 'pending' AND result IS NULL AND completed_at IS NULL)
    OR (lifecycle = 'unavailable' AND result IS NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT network_diagnostics_result_json CHECK (result IS NULL OR json_valid(result)),
  CONSTRAINT network_diagnostics_failure_code CHECK (
    failure_code IS NULL OR failure_code IN (
      'worker_unsupported_or_missing', 'protocol_invalid_response', 'scheduler_abandoned'
    )
  ),
  CONSTRAINT network_diagnostics_monitor_region_kind_window_unique
    UNIQUE (monitor_id, region_id, kind, window_started_at)
);

CREATE INDEX network_diagnostics_monitor_region_time_idx
  ON network_diagnostics (monitor_id, region_id, window_started_at);
CREATE INDEX network_diagnostics_lifecycle_time_idx
  ON network_diagnostics (lifecycle, requested_at);
CREATE INDEX network_diagnostics_created_at_idx ON network_diagnostics (created_at);

-- ---------------------------------------------------------------------------
-- Notification providers, membership, state, deliveries
-- ---------------------------------------------------------------------------

CREATE TABLE notification_services (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Opaque provider configuration, including credentials encrypted with a
  -- Worker secret. Never selected into public reports.
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT notification_services_config_json CHECK (json_valid(config)),
  CONSTRAINT notification_services_provider_check CHECK (
    provider IN ('telegram', 'discord', 'resend', 'gotify', 'webhook', 'smtp', 'home-assistant')
  )
);

CREATE TABLE monitor_notification_services (
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  notification_service_id TEXT NOT NULL REFERENCES notification_services (id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, notification_service_id)
);

CREATE INDEX monitor_notification_services_service_idx
  ON monitor_notification_services (notification_service_id);

CREATE TABLE monitor_notification_state (
  monitor_id TEXT PRIMARY KEY NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  config_fingerprint TEXT NOT NULL,
  last_window_started_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  failure_streak INTEGER NOT NULL DEFAULT 0,
  success_streak INTEGER NOT NULL DEFAULT 0,
  outage_started_at TEXT,
  last_reminder_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT monitor_notification_state_status CHECK (status IN ('healthy', 'down'))
);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  notification_service_id TEXT NOT NULL REFERENCES notification_services (id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lease_until TEXT,
  lease_token TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT,
  last_error TEXT,
  CONSTRAINT notification_deliveries_kind CHECK (kind IN ('outage', 'recovery', 'reminder')),
  CONSTRAINT notification_deliveries_status CHECK (
    status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')
  ),
  CONSTRAINT notification_deliveries_message_json CHECK (json_valid(message)),
  CONSTRAINT notification_deliveries_event_key_service_unique
    UNIQUE (event_key, notification_service_id)
);

CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (status, next_attempt_at);
CREATE INDEX notification_deliveries_monitor_idx ON notification_deliveries (monitor_id);

-- ---------------------------------------------------------------------------
-- Exact daily aggregates
-- ---------------------------------------------------------------------------

CREATE TABLE monitor_daily_uptime (
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  uptime_percentage REAL NOT NULL,
  average_response_ms REAL,
  weight REAL NOT NULL DEFAULT 1,
  received_count INTEGER,
  success_count INTEGER,
  response_sum_ms REAL NOT NULL DEFAULT 0,
  response_count_ms INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'calculated',
  finalized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (monitor_id, day),
  CONSTRAINT monitor_daily_uptime_day_format CHECK (
    length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  CONSTRAINT monitor_daily_uptime_percentage_range CHECK (uptime_percentage BETWEEN 0 AND 100),
  CONSTRAINT monitor_daily_uptime_average_response_nonnegative CHECK (
    average_response_ms IS NULL OR average_response_ms >= 0
  ),
  CONSTRAINT monitor_daily_uptime_weight_positive CHECK (weight > 0),
  CONSTRAINT monitor_daily_uptime_counts_consistent CHECK (
    (received_count IS NULL AND success_count IS NULL)
    OR (received_count > 0 AND success_count BETWEEN 0 AND received_count)
  ),
  CONSTRAINT monitor_daily_uptime_sums_nonnegative CHECK (
    response_sum_ms >= 0 AND response_count_ms >= 0
  )
);

CREATE INDEX monitor_daily_uptime_day_idx ON monitor_daily_uptime (day, monitor_id);


-- ---------------------------------------------------------------------------
-- Coordination / publication / maintenance progress
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  name TEXT PRIMARY KEY NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  cursor TEXT,
  state_json TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT jobs_cursor_json CHECK (cursor IS NULL OR json_valid(cursor)),
  CONSTRAINT jobs_state_json CHECK (state_json IS NULL OR json_valid(state_json))
);

CREATE TABLE report_publications (
  report_key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  -- Keep the publication row as a tombstone after its source is deleted so
  -- reconciliation can remove the corresponding R2 object and retry failures.
  status_page_id TEXT REFERENCES status_pages (id) ON DELETE SET NULL,
  monitor_id TEXT REFERENCES monitors (id) ON DELETE SET NULL,
  object_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT,
  latest_observation_at TEXT,
  source_watermark TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_until TEXT,
  lease_token TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT report_publications_kind CHECK (kind IN ('status-page', 'monitor', 'index')),
  CONSTRAINT report_publications_status CHECK (status IN ('pending', 'complete', 'failed'))
);

CREATE INDEX report_publications_status_idx ON report_publications (status, updated_at);
CREATE INDEX report_publications_status_page_idx ON report_publications (status_page_id);
CREATE INDEX report_publications_monitor_idx ON report_publications (monitor_id);

-- ---------------------------------------------------------------------------
-- Idempotent exact aggregate maintenance
-- ---------------------------------------------------------------------------
--
-- Daily aggregates are maintained exactly once per finalized round and once per
-- late-arriving observation:
--
--   1. `check_runs_finalize_aggregate` fires when a run first becomes
--      complete/partial, summing every observation already stored for it.
--   2. `observations_accumulate_finalized` fires for observations that arrive
--      after their round was finalized (late/retried probe results).
--
-- Because `observations` has a durable unique key on
-- (monitor_id, region_id, scheduled_window), a duplicate result is rejected and
-- neither trigger runs twice. Both triggers only update rows whose
-- `source = 'calculated'`, so imported history is never overwritten. Retention
-- deletes do not decrement aggregates: long-term daily history survives raw
-- result expiry.

CREATE TRIGGER check_runs_finalize_aggregate
AFTER UPDATE OF status ON check_runs
FOR EACH ROW
WHEN OLD.status = 'pending' AND NEW.status IN ('complete', 'partial')
BEGIN
  INSERT INTO monitor_daily_uptime (
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
      THEN sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN o.response_ms ELSE 0 END)
        * 1.0
        / sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN 1 ELSE 0 END)
      ELSE NULL
    END,
    count(*),
    count(*),
    sum(CASE WHEN o.success = 1 THEN 1 ELSE 0 END),
    sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN o.response_ms ELSE 0 END),
    sum(CASE WHEN o.success = 1 AND o.response_ms IS NOT NULL THEN 1 ELSE 0 END),
    'calculated',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM observations o
  WHERE o.check_run_id = NEW.id
  GROUP BY NEW.monitor_id
  HAVING count(*) > 0
  ON CONFLICT (monitor_id, day) DO UPDATE SET
    received_count = monitor_daily_uptime.received_count + excluded.received_count,
    success_count = monitor_daily_uptime.success_count + excluded.success_count,
    response_sum_ms = monitor_daily_uptime.response_sum_ms + excluded.response_sum_ms,
    response_count_ms = monitor_daily_uptime.response_count_ms + excluded.response_count_ms,
    uptime_percentage = (
      (monitor_daily_uptime.success_count + excluded.success_count) * 100.0
    ) / (monitor_daily_uptime.received_count + excluded.received_count),
    average_response_ms = CASE
      WHEN (monitor_daily_uptime.response_count_ms + excluded.response_count_ms) > 0
      THEN (monitor_daily_uptime.response_sum_ms + excluded.response_sum_ms) * 1.0
        / (monitor_daily_uptime.response_count_ms + excluded.response_count_ms)
      ELSE NULL
    END,
    weight = monitor_daily_uptime.received_count + excluded.received_count,
    finalized_at = excluded.finalized_at,
    updated_at = excluded.updated_at
  WHERE monitor_daily_uptime.source = 'calculated';
END;

CREATE TRIGGER observations_accumulate_finalized
AFTER INSERT ON observations
FOR EACH ROW
WHEN (SELECT status FROM check_runs WHERE id = NEW.check_run_id) IN ('complete', 'partial')
BEGIN
  INSERT INTO monitor_daily_uptime (
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
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (monitor_id, day) DO UPDATE SET
    received_count = monitor_daily_uptime.received_count + 1,
    success_count = monitor_daily_uptime.success_count
      + CASE WHEN NEW.success = 1 THEN 1 ELSE 0 END,
    response_sum_ms = monitor_daily_uptime.response_sum_ms
      + CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN NEW.response_ms ELSE 0 END,
    response_count_ms = monitor_daily_uptime.response_count_ms
      + CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN 1 ELSE 0 END,
    uptime_percentage = (
      (monitor_daily_uptime.success_count + CASE WHEN NEW.success = 1 THEN 1 ELSE 0 END) * 100.0
    ) / (monitor_daily_uptime.received_count + 1),
    average_response_ms = CASE
      WHEN (
        monitor_daily_uptime.response_count_ms
          + CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN 1 ELSE 0 END
      ) > 0
      THEN (
        monitor_daily_uptime.response_sum_ms
          + CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN NEW.response_ms ELSE 0 END
      ) * 1.0 / (
        monitor_daily_uptime.response_count_ms
          + CASE WHEN NEW.success = 1 AND NEW.response_ms IS NOT NULL THEN 1 ELSE 0 END
      )
      ELSE NULL
    END,
    weight = monitor_daily_uptime.received_count + 1,
    finalized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE monitor_daily_uptime.source = 'calculated';
END;
