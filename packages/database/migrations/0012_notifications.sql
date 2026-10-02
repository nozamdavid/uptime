ALTER TABLE monitors ADD COLUMN outage_threshold integer NOT NULL DEFAULT 3 CHECK (outage_threshold BETWEEN 1 AND 100);
ALTER TABLE monitors ADD COLUMN recovery_threshold integer NOT NULL DEFAULT 2 CHECK (recovery_threshold BETWEEN 1 AND 100);
ALTER TABLE monitors ADD COLUMN repeat_notification_minutes integer CHECK (repeat_notification_minutes BETWEEN 1 AND 10080);
--> statement-breakpoint
CREATE TABLE notification_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('telegram', 'discord')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE monitor_notification_services (
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  notification_service_id uuid NOT NULL REFERENCES notification_services(id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, notification_service_id)
);
CREATE INDEX monitor_notification_services_service_idx ON monitor_notification_services(notification_service_id);
--> statement-breakpoint
CREATE TABLE monitor_notification_state (
  monitor_id uuid PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  config_fingerprint text NOT NULL,
  last_window_started_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'down')),
  failure_streak integer NOT NULL DEFAULT 0,
  success_streak integer NOT NULL DEFAULT 0,
  outage_started_at timestamptz,
  last_reminder_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  notification_service_id uuid NOT NULL REFERENCES notification_services(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('outage', 'recovery', 'reminder')),
  message jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  UNIQUE (event_key, notification_service_id)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries(status, next_attempt_at);
CREATE INDEX notification_deliveries_monitor_idx ON notification_deliveries(monitor_id);
