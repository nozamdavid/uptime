-- Widen the provider CHECK while preserving rows in both dependent tables.
-- Dropping this parent table cascades, so snapshot and restore its references.
CREATE TABLE notification_service_membership_backup_0011 AS
SELECT monitor_id, notification_service_id FROM monitor_notification_services;
CREATE TABLE notification_delivery_backup_0011 AS
SELECT * FROM notification_deliveries;

CREATE TABLE notification_services_bluesky (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT notification_services_config_json CHECK (json_valid(config)),
  CONSTRAINT notification_services_provider_check CHECK (
    provider IN ('telegram', 'discord', 'resend', 'gotify', 'webhook', 'smtp', 'home-assistant', 'bluesky')
  )
);

INSERT INTO notification_services_bluesky
  (id, name, provider, enabled, config, created_at, updated_at)
SELECT id, name, provider, enabled, config, created_at, updated_at
FROM notification_services;

DROP TABLE notification_services;
ALTER TABLE notification_services_bluesky RENAME TO notification_services;

INSERT INTO monitor_notification_services (monitor_id, notification_service_id)
SELECT monitor_id, notification_service_id FROM notification_service_membership_backup_0011;
INSERT INTO notification_deliveries
  (id, monitor_id, notification_service_id, event_key, kind, message, status, attempts,
   next_attempt_at, lease_until, lease_token, created_at, sent_at, last_error)
SELECT id, monitor_id, notification_service_id, event_key, kind, message, status, attempts,
       next_attempt_at, lease_until, lease_token, created_at, sent_at, last_error
FROM notification_delivery_backup_0011;

DROP TABLE notification_service_membership_backup_0011;
DROP TABLE notification_delivery_backup_0011;
