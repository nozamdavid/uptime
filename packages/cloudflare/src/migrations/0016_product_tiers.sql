ALTER TABLE workspace_metadata ADD COLUMN tier_id TEXT NOT NULL DEFAULT 'free';
ALTER TABLE workspace_metadata ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK(catalog_revision>=0);
ALTER TABLE workspace_metadata ADD COLUMN entitlement_generation INTEGER NOT NULL DEFAULT 0 CHECK(entitlement_generation>=0);
ALTER TABLE workspace_metadata ADD COLUMN seat_limit INTEGER NOT NULL DEFAULT 3 CHECK(seat_limit BETWEEN 1 AND 1000);
ALTER TABLE workspace_metadata ADD COLUMN status_page_limit INTEGER NOT NULL DEFAULT 1 CHECK(status_page_limit BETWEEN 0 AND 1000);
ALTER TABLE workspace_metadata ADD COLUMN notification_destination_limit INTEGER NOT NULL DEFAULT 3 CHECK(notification_destination_limit BETWEEN 0 AND 1000);
ALTER TABLE workspace_metadata ADD COLUMN custom_domain_limit INTEGER NOT NULL DEFAULT 0 CHECK(custom_domain_limit BETWEEN 0 AND 1000);

DROP TRIGGER free_status_page_quota_insert;
CREATE TRIGGER free_status_page_quota_insert BEFORE INSERT ON status_pages
WHEN EXISTS(SELECT 1 FROM workspace_metadata WHERE id=1)
 AND (SELECT count(*) FROM status_pages)>=(SELECT status_page_limit FROM workspace_metadata WHERE id=1)
BEGIN SELECT RAISE(ABORT,'free_status_limit'); END;
DROP TRIGGER free_service_quota_insert;
CREATE TRIGGER free_service_quota_insert BEFORE INSERT ON notification_services
WHEN EXISTS(SELECT 1 FROM workspace_metadata WHERE id=1)
 AND ((SELECT count(*) FROM notification_services)>=(SELECT notification_destination_limit FROM workspace_metadata WHERE id=1)
 OR NEW.provider NOT IN ('telegram','discord'))
BEGIN SELECT RAISE(ABORT,'free_notification_limit'); END;

CREATE TRIGGER tier_notification_link_update BEFORE UPDATE ON monitor_notification_services
WHEN EXISTS(SELECT 1 FROM workspace_metadata WHERE id=1)
 AND NEW.monitor_id<>OLD.monitor_id
 AND (SELECT count(*) FROM monitor_notification_services WHERE monitor_id=NEW.monitor_id)
 >=(SELECT notification_destination_limit FROM workspace_metadata WHERE id=1)
BEGIN SELECT RAISE(ABORT,'free_notification_limit'); END;
DROP TRIGGER free_notification_quota_insert;
CREATE TRIGGER free_notification_quota_insert BEFORE INSERT ON monitor_notification_services
WHEN EXISTS(SELECT 1 FROM workspace_metadata WHERE id=1)
 AND (SELECT count(*) FROM monitor_notification_services WHERE monitor_id=NEW.monitor_id)
 >=(SELECT notification_destination_limit FROM workspace_metadata WHERE id=1)
BEGIN SELECT RAISE(ABORT,'free_notification_limit'); END;

-- Stable selection permits disabling earlier monitors to make room without deleting saved monitors.
-- A narrowed region policy pauses incompatible monitors instead of deleting their regions.
CREATE VIEW tier_schedulable_monitors AS
SELECT m.* FROM monitors m WHERE m.enabled=1
 AND m.id IN (SELECT id FROM monitors WHERE enabled=1 ORDER BY created_at,id
   LIMIT COALESCE((SELECT monitor_limit FROM workspace_metadata WHERE id=1),1000000))
 AND (SELECT count(*) FROM monitor_regions WHERE monitor_id=m.id)
   <=COALESCE((SELECT region_limit FROM workspace_metadata WHERE id=1),9)
 AND NOT EXISTS(SELECT 1 FROM monitor_regions mr WHERE mr.monitor_id=m.id
   AND EXISTS(SELECT 1 FROM workspace_metadata WHERE id=1)
   AND NOT EXISTS(SELECT 1 FROM json_each((SELECT allowed_region_ids FROM workspace_metadata WHERE id=1))
      WHERE value=mr.region_id));

-- Old scheduler versions also fail closed after a downgrade has been synchronized.
CREATE TRIGGER tier_check_run_insert BEFORE INSERT ON check_runs
WHEN EXISTS(SELECT 1 FROM workspace_metadata WHERE id=1)
 AND (NEW.monitor_id NOT IN (SELECT id FROM tier_schedulable_monitors)
   OR NEW.expected_region_count>(SELECT region_limit FROM workspace_metadata WHERE id=1)
   OR EXISTS(SELECT 1 FROM json_each(NEW.expected_regions) r WHERE NOT EXISTS(
     SELECT 1 FROM json_each((SELECT allowed_region_ids FROM workspace_metadata WHERE id=1)) a WHERE a.value=r.value)))
BEGIN SELECT RAISE(ABORT,'tier_scheduling_limit'); END;

CREATE VIEW tier_active_notification_services AS
SELECT * FROM notification_services WHERE enabled=1 AND provider IN ('telegram','discord')
ORDER BY created_at,id
LIMIT COALESCE((SELECT notification_destination_limit FROM workspace_metadata WHERE id=1),1000000);

CREATE TRIGGER tier_notification_delivery_lease BEFORE UPDATE OF status ON notification_deliveries
WHEN NEW.status='sending' AND EXISTS(SELECT 1 FROM workspace_metadata WHERE id=1)
 AND (NEW.monitor_id NOT IN (SELECT id FROM tier_schedulable_monitors)
   OR NEW.notification_service_id NOT IN (SELECT id FROM tier_active_notification_services))
BEGIN SELECT RAISE(ABORT,'tier_notification_delivery_limit'); END;
