-- Keep recurring retention work proportional to the expired rows it removes.
-- These partial indexes mirror the eligibility predicates in coordinator
-- maintenance and exclude live/pending records from the index entirely.

CREATE INDEX check_runs_retention_idx
  ON check_runs (created_at, id)
  WHERE status IN ('complete', 'partial') AND finalized_at IS NOT NULL;

CREATE INDEX network_diagnostics_retention_idx
  ON network_diagnostics (created_at, id)
  WHERE lifecycle <> 'pending';

CREATE INDEX notification_deliveries_retention_idx
  ON notification_deliveries (created_at, id)
  WHERE status IN ('sent', 'cancelled', 'failed');
