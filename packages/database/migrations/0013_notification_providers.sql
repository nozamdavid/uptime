ALTER TABLE notification_services DROP CONSTRAINT notification_services_provider_check;
ALTER TABLE notification_services ADD CONSTRAINT notification_services_provider_check
  CHECK (provider IN ('telegram', 'discord', 'resend', 'gotify', 'webhook', 'smtp', 'home-assistant'));
