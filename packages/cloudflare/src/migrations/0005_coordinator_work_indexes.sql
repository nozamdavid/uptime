-- Keep recurring coordinator work proportional to live work rather than the
-- retained delivery/observation history.

-- Incident evaluation only asks whether a monitor already has an active
-- delivery. Terminal rows are retained for audit but must not grow that probe.
CREATE INDEX notification_deliveries_active_monitor_idx
  ON notification_deliveries (monitor_id, id)
  WHERE status IN ('pending', 'sending');

-- Delivery claiming has separate clocks for never-sent and interrupted work.
-- These partial indexes exclude terminal history and let both sides of the OR
-- stop at the due/expired prefix.
CREATE INDEX notification_deliveries_pending_due_idx
  ON notification_deliveries (next_attempt_at, created_at, id)
  WHERE status = 'pending';

CREATE INDEX notification_deliveries_sending_lease_idx
  ON notification_deliveries (lease_until, created_at, id)
  WHERE status = 'sending';

-- Superseded by the two lifecycle-specific indexes above. Keeping the broad
-- status index lets SQLite prefer it and sort all matching history.
DROP INDEX notification_deliveries_due_idx;

-- Latency reports take the newest bounded sample. Include the deterministic
-- tiebreaker so a large monitor history does not need a temporary sort before
-- applying LIMIT.
CREATE INDEX observations_monitor_started_id_idx
  ON observations (monitor_id, started_at DESC, id DESC);

DROP INDEX observations_monitor_time_idx;

-- Foreign-key actions run child lookups for every deleted parent row. Without
-- these indexes, retention of each observation scans all diagnostics, and
-- deleting a provider or badge scans all retained deliveries/monitors.
CREATE INDEX network_diagnostics_observation_idx
  ON network_diagnostics (observation_id)
  WHERE observation_id IS NOT NULL;

CREATE INDEX notification_deliveries_service_idx
  ON notification_deliveries (notification_service_id);

CREATE INDEX monitors_badge_idx
  ON monitors (badge_id)
  WHERE badge_id IS NOT NULL;
