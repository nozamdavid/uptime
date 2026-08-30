CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE region_id AS ENUM ('us-east', 'eu-west', 'asia');
CREATE TYPE run_status AS ENUM ('pending', 'complete', 'partial');
CREATE TYPE observation_status AS ENUM ('success', 'http_failure', 'network_failure');
CREATE TYPE observation_error_code AS ENUM ('timeout', 'dns', 'connection', 'tls', 'redirect_limit', 'response_too_large', 'invalid_response', 'probe_rejected', 'probe_unreachable', 'unknown');

CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), singleton_key boolean NOT NULL DEFAULT true,
  email text NOT NULL, password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admins_singleton_key_unique UNIQUE (singleton_key), CONSTRAINT admins_email_unique UNIQUE (email),
  CONSTRAINT admins_singleton_key_true CHECK (singleton_key = true)
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);
CREATE INDEX sessions_admin_expires_idx ON sessions (admin_id, expires_at);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, url text NOT NULL,
  interval_seconds integer NOT NULL, timeout_ms integer NOT NULL, enabled boolean NOT NULL DEFAULT true,
  next_check_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monitors_http_url CHECK (url ~ '^https?://'),
  CONSTRAINT monitors_interval_preset CHECK (interval_seconds IN (60, 300, 900, 1800, 3600)),
  CONSTRAINT monitors_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 30000),
  CONSTRAINT monitors_timeout_before_interval CHECK (timeout_ms < interval_seconds * 1000)
);
CREATE INDEX monitors_due_idx ON monitors (enabled, next_check_at);
CREATE TABLE monitor_regions (
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE, region_id region_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (monitor_id, region_id)
);
CREATE INDEX monitor_regions_region_idx ON monitor_regions (region_id, monitor_id);

CREATE TABLE check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL, status run_status NOT NULL DEFAULT 'pending', expected_region_count integer NOT NULL,
  monitor_url text NOT NULL, timeout_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CONSTRAINT check_runs_monitor_window_unique UNIQUE (monitor_id, window_started_at),
  CONSTRAINT check_runs_id_monitor_unique UNIQUE (id, monitor_id),
  CONSTRAINT check_runs_region_count CHECK (expected_region_count BETWEEN 1 AND 3),
  CONSTRAINT check_runs_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 30000)
);
CREATE INDEX check_runs_monitor_time_idx ON check_runs (monitor_id, window_started_at);
CREATE INDEX check_runs_status_time_idx ON check_runs (status, window_started_at);

CREATE TABLE observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_run_id uuid NOT NULL, monitor_id uuid NOT NULL, region_id region_id NOT NULL,
  status observation_status NOT NULL, success boolean NOT NULL, http_status integer,
  response_ms double precision, total_ms double precision, error_code observation_error_code, error_detail text,
  placement text, colo text, final_url text, redirect_count integer, body_bytes integer, probe_version text,
  response_metadata jsonb, started_at timestamptz NOT NULL, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT observations_run_monitor_fk FOREIGN KEY (check_run_id, monitor_id) REFERENCES check_runs(id, monitor_id) ON DELETE CASCADE,
  CONSTRAINT observations_run_region_unique UNIQUE (check_run_id, region_id),
  CONSTRAINT observations_http_status_range CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT observations_nonnegative_timings CHECK ((response_ms IS NULL OR response_ms >= 0) AND (total_ms IS NULL OR total_ms >= 0)),
  CONSTRAINT observations_redirect_range CHECK (redirect_count IS NULL OR redirect_count BETWEEN 0 AND 5),
  CONSTRAINT observations_body_bytes_nonnegative CHECK (body_bytes IS NULL OR body_bytes >= 0),
  CONSTRAINT observations_success_consistent CHECK ((success AND status = 'success') OR (NOT success AND status <> 'success'))
);
CREATE INDEX observations_monitor_region_time_idx ON observations (monitor_id, region_id, started_at DESC);
CREATE INDEX observations_monitor_time_idx ON observations (monitor_id, started_at DESC);
CREATE INDEX observations_error_time_idx ON observations (error_code, started_at DESC);
CREATE INDEX observations_created_at_idx ON observations (created_at);
