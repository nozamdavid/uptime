CREATE TABLE report_cache_revisions (
  cache_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);

INSERT INTO report_cache_revisions (cache_key, revision)
VALUES ('monitor_daily_uptime', 0);

CREATE TRIGGER monitor_daily_uptime_closed_insert_revision
AFTER INSERT ON monitor_daily_uptime WHEN NEW.day < date('now')
BEGIN
  UPDATE report_cache_revisions SET revision = revision + 1
  WHERE cache_key = 'monitor_daily_uptime';
END;

CREATE TRIGGER monitor_daily_uptime_closed_update_revision
AFTER UPDATE ON monitor_daily_uptime WHEN OLD.day < date('now') OR NEW.day < date('now')
BEGIN
  UPDATE report_cache_revisions SET revision = revision + 1
  WHERE cache_key = 'monitor_daily_uptime';
END;

CREATE TRIGGER monitor_daily_uptime_closed_delete_revision
AFTER DELETE ON monitor_daily_uptime WHEN OLD.day < date('now')
BEGIN
  UPDATE report_cache_revisions SET revision = revision + 1
  WHERE cache_key = 'monitor_daily_uptime';
END;
