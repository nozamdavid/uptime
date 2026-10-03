-- The report worker no longer reads this feed. Retain the table for one
-- compatibility window so an older worker can still drain existing rows.
DROP TRIGGER IF EXISTS observations_report_latency_insert;
DROP TRIGGER IF EXISTS observations_report_latency_update;
DROP TRIGGER IF EXISTS observations_report_latency_delete;
