CREATE TABLE report_latency_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation INTEGER NOT NULL,
  observation_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  region_id TEXT,
  success INTEGER,
  started_at TEXT,
  value REAL,
  CONSTRAINT report_latency_changes_operation CHECK (operation IN (0, 1))
);

CREATE TRIGGER observations_report_latency_insert
AFTER INSERT ON observations
BEGIN
  INSERT INTO report_latency_changes (
    operation, observation_id, monitor_id, region_id, success, started_at, value
  ) VALUES (
    1, NEW.id, NEW.monitor_id, NEW.region_id, NEW.success, NEW.started_at,
    COALESCE(NEW.response_ms, CASE WHEN NEW.error_code = 'timeout' THEN NEW.total_ms END)
  );
END;

CREATE TRIGGER observations_report_latency_update
AFTER UPDATE ON observations
BEGIN
  INSERT INTO report_latency_changes (operation, observation_id, monitor_id)
  VALUES (0, OLD.id, OLD.monitor_id);
  INSERT INTO report_latency_changes (
    operation, observation_id, monitor_id, region_id, success, started_at, value
  ) VALUES (
    1, NEW.id, NEW.monitor_id, NEW.region_id, NEW.success, NEW.started_at,
    COALESCE(NEW.response_ms, CASE WHEN NEW.error_code = 'timeout' THEN NEW.total_ms END)
  );
END;

CREATE TRIGGER observations_report_latency_delete
AFTER DELETE ON observations
BEGIN
  INSERT INTO report_latency_changes (operation, observation_id, monitor_id)
  VALUES (0, OLD.id, OLD.monitor_id);
END;
