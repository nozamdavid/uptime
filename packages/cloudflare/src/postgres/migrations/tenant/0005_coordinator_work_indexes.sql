-- Tenant migration 0005: Coordinator work indexes
-- Partial and covering indexes for coordinator scheduling, delivery leasing, and latency scanning

CREATE INDEX IF NOT EXISTS notification_deliveries_active_monitor_idx
  ON {{schema}}.notification_deliveries (monitor_id, id)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS notification_deliveries_pending_due_idx
  ON {{schema}}.notification_deliveries (next_attempt_at, created_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS notification_deliveries_sending_lease_idx
  ON {{schema}}.notification_deliveries (lease_until, created_at, id)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS observations_monitor_started_id_idx
  ON {{schema}}.observations (monitor_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_diagnostics_observation_idx
  ON {{schema}}.network_diagnostics (observation_id)
  WHERE observation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_deliveries_service_idx
  ON {{schema}}.notification_deliveries (notification_service_id);

CREATE INDEX IF NOT EXISTS monitors_badge_idx
  ON {{schema}}.monitors (badge_id)
  WHERE badge_id IS NOT NULL;
