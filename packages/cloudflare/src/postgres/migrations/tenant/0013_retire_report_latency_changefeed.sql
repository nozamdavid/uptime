-- Tenant migration 0013_retire_report_latency_changefeed: Retire changefeed writes
-- Drops latency changefeed triggers on observations while retaining historical table rows

DROP TRIGGER IF EXISTS observations_report_latency_insert ON {{schema}}.observations;
DROP TRIGGER IF EXISTS observations_report_latency_update ON {{schema}}.observations;
DROP TRIGGER IF EXISTS observations_report_latency_delete ON {{schema}}.observations;
