-- Tenant migration 0002: Retention indexes
-- Partial indexes for data retention cleanup jobs

CREATE INDEX IF NOT EXISTS check_runs_retention_idx
  ON {{schema}}.check_runs (created_at, id)
  WHERE status IN ('complete', 'partial') AND finalized_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS network_diagnostics_retention_idx
  ON {{schema}}.network_diagnostics (created_at, id)
  WHERE lifecycle <> 'pending';

CREATE INDEX IF NOT EXISTS notification_deliveries_retention_idx
  ON {{schema}}.notification_deliveries (created_at, id)
  WHERE status IN ('sent', 'cancelled', 'failed');
