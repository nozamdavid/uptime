-- Tenant migration 0007: Report uptime cache revision
-- Table: report_cache_revisions
-- Triggers: monitor_daily_uptime cache revision bump on closed days (< CURRENT_DATE)

CREATE TABLE IF NOT EXISTS {{schema}}.report_cache_revisions (
  cache_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);

INSERT INTO {{schema}}.report_cache_revisions (cache_key, revision)
VALUES ('monitor_daily_uptime', 0)
ON CONFLICT (cache_key) DO NOTHING;

CREATE OR REPLACE FUNCTION {{schema}}.monitor_daily_uptime_cache_revision_func()
RETURNS trigger AS $$
DECLARE
  v_today TEXT;
BEGIN
  v_today := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD');

  IF TG_OP = 'INSERT' THEN
    IF NEW.day < v_today THEN
      UPDATE {{schema}}.report_cache_revisions
         SET revision = revision + 1
       WHERE cache_key = 'monitor_daily_uptime';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.day < v_today OR NEW.day < v_today THEN
      UPDATE {{schema}}.report_cache_revisions
         SET revision = revision + 1
       WHERE cache_key = 'monitor_daily_uptime';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.day < v_today THEN
      UPDATE {{schema}}.report_cache_revisions
         SET revision = revision + 1
       WHERE cache_key = 'monitor_daily_uptime';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER monitor_daily_uptime_closed_insert_revision
AFTER INSERT ON {{schema}}.monitor_daily_uptime
FOR EACH ROW EXECUTE FUNCTION {{schema}}.monitor_daily_uptime_cache_revision_func();

CREATE OR REPLACE TRIGGER monitor_daily_uptime_closed_update_revision
AFTER UPDATE ON {{schema}}.monitor_daily_uptime
FOR EACH ROW EXECUTE FUNCTION {{schema}}.monitor_daily_uptime_cache_revision_func();

CREATE OR REPLACE TRIGGER monitor_daily_uptime_closed_delete_revision
AFTER DELETE ON {{schema}}.monitor_daily_uptime
FOR EACH ROW EXECUTE FUNCTION {{schema}}.monitor_daily_uptime_cache_revision_func();
