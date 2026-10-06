-- Tenant migration 0004: API query indexes
-- Composite indexes for high-volume observation and diagnostic history queries

CREATE INDEX IF NOT EXISTS observations_monitor_region_started_id_idx
  ON {{schema}}.observations (monitor_id, region_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_diagnostics_monitor_requested_id_idx
  ON {{schema}}.network_diagnostics (monitor_id, requested_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_diagnostics_monitor_region_requested_id_idx
  ON {{schema}}.network_diagnostics (monitor_id, region_id, requested_at DESC, id DESC);
