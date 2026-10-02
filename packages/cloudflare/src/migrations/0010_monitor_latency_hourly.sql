-- Closed hours are compacted by the coordinator. Dirty keys coalesce repeated
-- observation writes without rewriting a growing aggregate on every probe.
CREATE TABLE monitor_latency_hourly (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,
  region_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (monitor_id, hour, region_id)
) WITHOUT ROWID;

CREATE INDEX monitor_latency_hourly_hour_idx ON monitor_latency_hourly (hour, monitor_id, region_id);

CREATE TABLE monitor_latency_dirty (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,
  PRIMARY KEY (monitor_id, hour)
) WITHOUT ROWID;

CREATE INDEX monitor_latency_dirty_hour_idx ON monitor_latency_dirty (hour, monitor_id);

-- Coverage is committed only after a complete, explicit historical backfill.
CREATE TABLE monitor_latency_coverage (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  since TEXT NOT NULL
);

-- A newly created monitor has no unaggregated pre-migration history.
CREATE TRIGGER monitors_latency_coverage_insert
AFTER INSERT ON monitors
BEGIN
  INSERT INTO monitor_latency_coverage (monitor_id, since)
  VALUES (NEW.id, '1970-01-01T00:00:00.000Z');
END;

CREATE TRIGGER observations_latency_hourly_insert
AFTER INSERT ON observations
BEGIN
  INSERT INTO monitor_latency_dirty (monitor_id, hour)
  VALUES (NEW.monitor_id, strftime('%Y-%m-%dT%H:00:00.000Z', NEW.started_at))
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER observations_latency_hourly_update
AFTER UPDATE ON observations
BEGIN
  INSERT INTO monitor_latency_dirty (monitor_id, hour)
  SELECT OLD.monitor_id, strftime('%Y-%m-%dT%H:00:00.000Z', OLD.started_at)
  WHERE EXISTS (SELECT 1 FROM monitors WHERE id = OLD.monitor_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO monitor_latency_dirty (monitor_id, hour)
  VALUES (NEW.monitor_id, strftime('%Y-%m-%dT%H:00:00.000Z', NEW.started_at))
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER observations_latency_hourly_delete
AFTER DELETE ON observations
BEGIN
  INSERT INTO monitor_latency_dirty (monitor_id, hour)
  SELECT OLD.monitor_id, strftime('%Y-%m-%dT%H:00:00.000Z', OLD.started_at)
  WHERE EXISTS (SELECT 1 FROM monitors WHERE id = OLD.monitor_id)
  ON CONFLICT DO NOTHING;
END;
