-- Report recovery only needs to know whether each region failed in the
-- current UTC day. Keep healthy observations out of this index and allow each
-- region probe to stop at its first finalized failure.

CREATE INDEX observations_failed_run_region_idx
  ON observations (monitor_id, region_id, scheduled_window DESC, check_run_id)
  WHERE success = 0;
