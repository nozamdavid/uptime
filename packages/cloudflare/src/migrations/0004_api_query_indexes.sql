-- Stable cursor pagination needs the complete ORDER BY key in the index.
-- Without the id suffix SQLite builds and sorts a temporary result set for
-- every page, while DNS history cannot use its window_started_at index at all.

CREATE INDEX observations_monitor_region_started_id_idx
  ON observations (monitor_id, region_id, started_at DESC, id DESC);

DROP INDEX observations_monitor_region_time_idx;

CREATE INDEX network_diagnostics_monitor_requested_id_idx
  ON network_diagnostics (monitor_id, requested_at DESC, id DESC);

CREATE INDEX network_diagnostics_monitor_region_requested_id_idx
  ON network_diagnostics (monitor_id, region_id, requested_at DESC, id DESC);
