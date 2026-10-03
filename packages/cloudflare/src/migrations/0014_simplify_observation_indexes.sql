-- UNIQUE (check_run_id, region_id) already supports check-run lookups.
DROP INDEX IF EXISTS observations_check_run_idx;

-- Error codes are projected in reports, never used as a leading query key.
DROP INDEX IF EXISTS observations_error_time_idx;
