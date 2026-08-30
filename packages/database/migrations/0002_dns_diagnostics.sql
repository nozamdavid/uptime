ALTER TABLE monitors
  ADD COLUMN IF NOT EXISTS dns_diagnostics_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE check_runs
  ADD COLUMN IF NOT EXISTS dns_diagnostics_enabled boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE network_diagnostic_lifecycle AS ENUM ('pending', 'complete', 'unavailable');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS network_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  check_run_id uuid,
  observation_id uuid REFERENCES observations(id) ON DELETE SET NULL,
  region_id region_id NOT NULL,
  kind text NOT NULL DEFAULT 'dns_candidates',
  window_started_at timestamptz NOT NULL,
  lifecycle network_diagnostic_lifecycle NOT NULL DEFAULT 'pending',
  result jsonb,
  failure_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_diagnostics_run_monitor_fk
    FOREIGN KEY (check_run_id, monitor_id) REFERENCES check_runs(id, monitor_id) ON DELETE CASCADE,
  CONSTRAINT network_diagnostics_monitor_region_kind_window_unique
    UNIQUE (monitor_id, region_id, kind, window_started_at),
  CONSTRAINT network_diagnostics_dns_candidates_kind CHECK (kind = 'dns_candidates'),
  CONSTRAINT network_diagnostics_lifecycle_result CHECK (
    (lifecycle = 'complete' AND result IS NOT NULL AND completed_at IS NOT NULL)
    OR (lifecycle = 'pending' AND result IS NULL AND completed_at IS NULL)
    OR (lifecycle = 'unavailable' AND result IS NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT network_diagnostics_failure_code CHECK (
    failure_code IS NULL OR failure_code IN (
      'worker_unsupported_or_missing', 'protocol_invalid_response', 'scheduler_abandoned'
    )
  )
);
CREATE INDEX IF NOT EXISTS network_diagnostics_monitor_region_time_idx
  ON network_diagnostics (monitor_id, region_id, window_started_at DESC);
CREATE INDEX IF NOT EXISTS network_diagnostics_lifecycle_time_idx
  ON network_diagnostics (lifecycle, requested_at ASC);
CREATE INDEX IF NOT EXISTS network_diagnostics_created_at_idx
  ON network_diagnostics (created_at ASC);
