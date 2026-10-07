-- Tenant migration 0014: Simplify observation indexes
-- Drop redundant observation indexes

DROP INDEX IF EXISTS {{schema}}.observations_check_run_idx;
DROP INDEX IF EXISTS {{schema}}.observations_error_time_idx;
