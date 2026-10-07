-- Tenant migration 0003: Recovery indexes
-- Partial index on observations for fast regional outage lookups

CREATE INDEX IF NOT EXISTS observations_failed_run_region_idx
  ON {{schema}}.observations (monitor_id, region_id, scheduled_window DESC, check_run_id)
  WHERE success = 0;
