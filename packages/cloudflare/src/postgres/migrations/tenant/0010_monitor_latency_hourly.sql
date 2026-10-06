-- Tenant migration 0010: Monitor latency hourly aggregation
-- Tables: monitor_latency_hourly, monitor_latency_dirty, monitor_latency_coverage
-- Triggers: monitor_latency_dirty tracking on observations, coverage tracking on monitors

CREATE TABLE IF NOT EXISTS {{schema}}.monitor_latency_hourly (
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,
  region_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (payload IS JSON),
  PRIMARY KEY (monitor_id, hour, region_id)
);
CREATE INDEX IF NOT EXISTS monitor_latency_hourly_hour_idx
  ON {{schema}}.monitor_latency_hourly (hour, monitor_id, region_id);

CREATE TABLE IF NOT EXISTS {{schema}}.monitor_latency_dirty (
  monitor_id TEXT NOT NULL REFERENCES {{schema}}.monitors(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,
  PRIMARY KEY (monitor_id, hour)
);
CREATE INDEX IF NOT EXISTS monitor_latency_dirty_hour_idx
  ON {{schema}}.monitor_latency_dirty (hour, monitor_id);

CREATE TABLE IF NOT EXISTS {{schema}}.monitor_latency_coverage (
  monitor_id TEXT PRIMARY KEY REFERENCES {{schema}}.monitors(id) ON DELETE CASCADE,
  since TEXT NOT NULL
);

INSERT INTO {{schema}}.monitor_latency_coverage (monitor_id, since)
SELECT id, '1970-01-01T00:00:00.000Z' FROM {{schema}}.monitors
ON CONFLICT (monitor_id) DO NOTHING;

CREATE OR REPLACE FUNCTION {{schema}}.monitors_latency_coverage_insert_func()
RETURNS trigger AS $$
BEGIN
  INSERT INTO {{schema}}.monitor_latency_coverage (monitor_id, since)
  VALUES (NEW.id, '1970-01-01T00:00:00.000Z')
  ON CONFLICT (monitor_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER monitors_latency_coverage_insert
AFTER INSERT ON {{schema}}.monitors
FOR EACH ROW EXECUTE FUNCTION {{schema}}.monitors_latency_coverage_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.observations_latency_hourly_insert_func()
RETURNS trigger AS $$
BEGIN
  IF NEW.started_at IS NOT NULL THEN
    INSERT INTO {{schema}}.monitor_latency_dirty (monitor_id, hour)
    VALUES (NEW.monitor_id, substr(NEW.started_at, 1, 13) || ':00:00.000Z')
    -- Hold the existing marker until the observation transaction commits.
    ON CONFLICT (monitor_id, hour) DO UPDATE SET hour = EXCLUDED.hour;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER observations_latency_hourly_insert
AFTER INSERT ON {{schema}}.observations
FOR EACH ROW EXECUTE FUNCTION {{schema}}.observations_latency_hourly_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.observations_latency_hourly_update_func()
RETURNS trigger AS $$
BEGIN
  -- Corrections and rebuilds acquire multiple hour keys in the same order.
  INSERT INTO {{schema}}.monitor_latency_dirty (monitor_id, hour)
  SELECT DISTINCT monitor_id, hour FROM (VALUES
    (NEW.monitor_id, substr(NEW.started_at, 1, 13) || ':00:00.000Z'),
    (OLD.monitor_id, substr(OLD.started_at, 1, 13) || ':00:00.000Z')
  ) AS affected(monitor_id, hour)
  WHERE hour IS NOT NULL ORDER BY monitor_id, hour
  ON CONFLICT (monitor_id, hour) DO UPDATE SET hour = EXCLUDED.hour;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER observations_latency_hourly_update
AFTER UPDATE OF id, monitor_id, region_id, response_ms, total_ms, error_code, success, started_at ON {{schema}}.observations
FOR EACH ROW EXECUTE FUNCTION {{schema}}.observations_latency_hourly_update_func();

CREATE OR REPLACE FUNCTION {{schema}}.observations_latency_hourly_delete_func()
RETURNS trigger AS $$
BEGIN
  -- Cascading monitor deletion has already removed the parent. Its hourly
  -- rows are also cascaded, so there is no surviving aggregate to invalidate.
  IF OLD.started_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM {{schema}}.monitors WHERE id = OLD.monitor_id
  ) THEN
    INSERT INTO {{schema}}.monitor_latency_dirty (monitor_id, hour)
    VALUES (OLD.monitor_id, substr(OLD.started_at, 1, 13) || ':00:00.000Z')
    ON CONFLICT (monitor_id, hour) DO UPDATE SET hour = EXCLUDED.hour;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER observations_latency_hourly_delete
AFTER DELETE ON {{schema}}.observations
FOR EACH ROW EXECUTE FUNCTION {{schema}}.observations_latency_hourly_delete_func();
