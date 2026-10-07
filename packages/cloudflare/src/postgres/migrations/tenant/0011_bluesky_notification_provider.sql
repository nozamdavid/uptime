-- Tenant migration 0011: Bluesky notification provider
-- Widens notification_services provider check constraint to include 'bluesky'

ALTER TABLE {{schema}}.notification_services
  DROP CONSTRAINT IF EXISTS notification_services_provider_check;

ALTER TABLE {{schema}}.notification_services
  ADD CONSTRAINT notification_services_provider_check
  CHECK (provider IN ('telegram', 'discord', 'resend', 'gotify', 'webhook', 'smtp', 'home-assistant', 'bluesky'));
