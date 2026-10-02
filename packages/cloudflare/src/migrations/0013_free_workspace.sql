CREATE TABLE IF NOT EXISTS workspace_metadata (
  id INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (id = 1),
  workspace_id TEXT NOT NULL,
  database_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan = 'free'),
  routing_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS verified_targets (
  id TEXT PRIMARY KEY NOT NULL,
  origin TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER IF NOT EXISTS free_monitor_quota_insert
BEFORE INSERT ON monitors
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (SELECT count(*) FROM monitors) >= 3
BEGIN SELECT RAISE(ABORT, 'free_monitor_limit'); END;
CREATE TRIGGER IF NOT EXISTS free_monitor_limits_insert
BEFORE INSERT ON monitors
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (NEW.interval_seconds <> 300 OR NEW.timeout_ms > 10000 OR NEW.dns_diagnostics_enabled <> 0
      OR NEW.outage_threshold <> 2 OR NEW.recovery_threshold <> 1 OR NEW.repeat_notification_minutes IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'free_policy_limit'); END;
CREATE TRIGGER IF NOT EXISTS free_monitor_limits_update
BEFORE UPDATE ON monitors
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (NEW.interval_seconds <> 300 OR NEW.timeout_ms > 10000 OR NEW.dns_diagnostics_enabled <> 0
      OR NEW.outage_threshold <> 2 OR NEW.recovery_threshold <> 1 OR NEW.repeat_notification_minutes IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'free_policy_limit'); END;
CREATE TRIGGER IF NOT EXISTS free_status_page_quota_insert
BEFORE INSERT ON status_pages
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (SELECT count(*) FROM status_pages) >= 1
BEGIN SELECT RAISE(ABORT, 'free_status_limit'); END;
CREATE TRIGGER IF NOT EXISTS free_notification_quota_insert
BEFORE INSERT ON monitor_notification_services
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (SELECT count(*) FROM monitor_notification_services WHERE monitor_id = NEW.monitor_id) >= 3
BEGIN SELECT RAISE(ABORT, 'free_notification_limit'); END;

CREATE TRIGGER free_region_quota_insert BEFORE INSERT ON monitor_regions
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (SELECT count(*) FROM monitor_regions WHERE monitor_id = NEW.monitor_id) >= 3
BEGIN SELECT RAISE(ABORT, 'free_region_limit'); END;

CREATE TRIGGER free_service_quota_insert BEFORE INSERT ON notification_services
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND ((SELECT count(*) FROM notification_services) >= 3 OR NEW.provider NOT IN ('telegram','discord'))
BEGIN SELECT RAISE(ABORT, 'free_notification_limit'); END;

CREATE TRIGGER free_service_provider_update BEFORE UPDATE OF provider ON notification_services
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free' AND NEW.provider NOT IN ('telegram','discord')
BEGIN SELECT RAISE(ABORT, 'free_notification_limit'); END;

CREATE TRIGGER free_badge_quota_insert BEFORE INSERT ON badges
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free' AND (SELECT count(*) FROM badges) >= 20
BEGIN SELECT RAISE(ABORT, 'free_policy_limit'); END;
