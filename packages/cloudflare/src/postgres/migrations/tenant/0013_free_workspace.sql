-- Tenant migration 0013_free_workspace: Workspace metadata and free tenant quotas
-- Tables: workspace_metadata, verified_targets
-- Triggers: Free tier resource limits and policies with MVCC singleton locking

CREATE TABLE IF NOT EXISTS {{schema}}.workspace_metadata (
  id INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (id = 1),
  workspace_id TEXT NOT NULL,
  database_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan = 'free'),
  routing_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS {{schema}}.verified_targets (
  id TEXT PRIMARY KEY NOT NULL,
  origin TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Triggers with MVCC locking on workspace_metadata singleton

CREATE OR REPLACE FUNCTION {{schema}}.free_monitor_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF (SELECT count(*) FROM {{schema}}.monitors) >= 3 THEN
      RAISE EXCEPTION 'free_monitor_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_monitor_quota_insert
BEFORE INSERT ON {{schema}}.monitors
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_monitor_quota_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.free_monitor_limits_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1;
  IF v_plan = 'free' THEN
    IF (NEW.interval_seconds <> 300 OR NEW.timeout_ms > 10000 OR NEW.dns_diagnostics_enabled <> 0
        OR NEW.outage_threshold <> 2 OR NEW.recovery_threshold <> 1 OR NEW.repeat_notification_minutes IS NOT NULL) THEN
      RAISE EXCEPTION 'free_policy_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_monitor_limits_insert
BEFORE INSERT ON {{schema}}.monitors
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_monitor_limits_func();

CREATE OR REPLACE TRIGGER free_monitor_limits_update
BEFORE UPDATE ON {{schema}}.monitors
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_monitor_limits_func();

CREATE OR REPLACE FUNCTION {{schema}}.free_status_page_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF (SELECT count(*) FROM {{schema}}.status_pages) >= 1 THEN
      RAISE EXCEPTION 'free_status_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_status_page_quota_insert
BEFORE INSERT ON {{schema}}.status_pages
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_status_page_quota_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.free_notification_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF (SELECT count(*) FROM {{schema}}.monitor_notification_services WHERE monitor_id = NEW.monitor_id) >= 3 THEN
      RAISE EXCEPTION 'free_notification_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_notification_quota_insert
BEFORE INSERT ON {{schema}}.monitor_notification_services
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_notification_quota_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.free_region_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF (SELECT count(*) FROM {{schema}}.monitor_regions WHERE monitor_id = NEW.monitor_id) >= 3 THEN
      RAISE EXCEPTION 'free_region_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_region_quota_insert
BEFORE INSERT ON {{schema}}.monitor_regions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_region_quota_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.free_service_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF ((SELECT count(*) FROM {{schema}}.notification_services) >= 3 OR NEW.provider NOT IN ('telegram', 'discord')) THEN
      RAISE EXCEPTION 'free_notification_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_service_quota_insert
BEFORE INSERT ON {{schema}}.notification_services
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_service_quota_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.free_service_provider_update_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1;
  IF v_plan = 'free' AND NEW.provider NOT IN ('telegram', 'discord') THEN
    RAISE EXCEPTION 'free_notification_limit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_service_provider_update
BEFORE UPDATE OF provider ON {{schema}}.notification_services
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_service_provider_update_func();

CREATE OR REPLACE FUNCTION {{schema}}.free_badge_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
BEGIN
  SELECT plan INTO v_plan FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' AND (SELECT count(*) FROM {{schema}}.badges) >= 20 THEN
    RAISE EXCEPTION 'free_policy_limit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER free_badge_quota_insert
BEFORE INSERT ON {{schema}}.badges
FOR EACH ROW EXECUTE FUNCTION {{schema}}.free_badge_quota_insert_func();
