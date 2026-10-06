-- Tenant migration 0016: Product tiers, schedulable monitor views & delivery leases
-- Alters workspace_metadata with tier limits
-- Views: tier_schedulable_monitors, tier_active_notification_services
-- Triggers: tier_check_run_insert, tier_notification_delivery_lease, free_status_page_quota_insert, free_service_quota_insert, free_notification_quota_insert, tier_notification_link_update

ALTER TABLE {{schema}}.workspace_metadata
  ADD COLUMN IF NOT EXISTS tier_id TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0),
  ADD COLUMN IF NOT EXISTS entitlement_generation INTEGER NOT NULL DEFAULT 0 CHECK (entitlement_generation >= 0),
  ADD COLUMN IF NOT EXISTS seat_limit INTEGER NOT NULL DEFAULT 3 CHECK (seat_limit BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS status_page_limit INTEGER NOT NULL DEFAULT 1 CHECK (status_page_limit BETWEEN 0 AND 1000),
  ADD COLUMN IF NOT EXISTS notification_destination_limit INTEGER NOT NULL DEFAULT 3 CHECK (notification_destination_limit BETWEEN 0 AND 1000),
  ADD COLUMN IF NOT EXISTS custom_domain_limit INTEGER NOT NULL DEFAULT 0 CHECK (custom_domain_limit BETWEEN 0 AND 1000);

-- Updated status page quota trigger
CREATE OR REPLACE FUNCTION {{schema}}.free_status_page_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_limit integer;
BEGIN
  SELECT status_page_limit INTO v_limit
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF FOUND THEN
    IF (SELECT count(*) FROM {{schema}}.status_pages) >= v_limit THEN
      RAISE EXCEPTION 'free_status_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Updated service quota trigger
CREATE OR REPLACE FUNCTION {{schema}}.free_service_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_limit integer;
BEGIN
  SELECT notification_destination_limit INTO v_limit
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF FOUND THEN
    IF ((SELECT count(*) FROM {{schema}}.notification_services) >= v_limit OR NEW.provider NOT IN ('telegram', 'discord')) THEN
      RAISE EXCEPTION 'free_notification_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Updated notification quota trigger on monitor_notification_services
CREATE OR REPLACE FUNCTION {{schema}}.free_notification_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_limit integer;
BEGIN
  SELECT notification_destination_limit INTO v_limit
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF FOUND THEN
    IF (SELECT count(*) FROM {{schema}}.monitor_notification_services WHERE monitor_id = NEW.monitor_id) >= v_limit THEN
      RAISE EXCEPTION 'free_notification_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION {{schema}}.tier_notification_link_update_func()
RETURNS trigger AS $$
DECLARE
  v_limit integer;
BEGIN
  IF NEW.monitor_id <> OLD.monitor_id THEN
    SELECT notification_destination_limit INTO v_limit
      FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
    IF FOUND THEN
      IF (SELECT count(*) FROM {{schema}}.monitor_notification_services WHERE monitor_id = NEW.monitor_id) >= v_limit THEN
        RAISE EXCEPTION 'free_notification_limit' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER tier_notification_link_update
BEFORE UPDATE ON {{schema}}.monitor_notification_services
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tier_notification_link_update_func();

-- Stable selection view: permits disabling earlier monitors to make room without deleting saved monitors.
CREATE OR REPLACE VIEW {{schema}}.tier_schedulable_monitors AS
SELECT m.*
FROM {{schema}}.monitors m
WHERE m.enabled = 1
  AND m.id IN (
    SELECT id
    FROM {{schema}}.monitors
    WHERE enabled = 1
    ORDER BY created_at, id
    LIMIT COALESCE((SELECT monitor_limit FROM {{schema}}.workspace_metadata WHERE id = 1), 1000000)
  )
  AND (SELECT count(*) FROM {{schema}}.monitor_regions WHERE monitor_id = m.id)
      <= COALESCE((SELECT region_limit FROM {{schema}}.workspace_metadata WHERE id = 1), 9)
  AND NOT EXISTS (
    SELECT 1
    FROM {{schema}}.monitor_regions mr
    WHERE mr.monitor_id = m.id
      AND EXISTS (SELECT 1 FROM {{schema}}.workspace_metadata WHERE id = 1)
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text((SELECT allowed_region_ids::jsonb FROM {{schema}}.workspace_metadata WHERE id = 1)) a
        WHERE a = mr.region_id
      )
  );

-- Tier check run scheduling policy trigger
CREATE OR REPLACE FUNCTION {{schema}}.tier_check_run_insert_func()
RETURNS trigger AS $$
DECLARE
  v_meta RECORD;
  v_invalid_region integer;
BEGIN
  SELECT * INTO v_meta FROM {{schema}}.workspace_metadata WHERE id = 1;
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM {{schema}}.tier_schedulable_monitors WHERE id = NEW.monitor_id
    ) THEN
      RAISE EXCEPTION 'tier_scheduling_limit' USING ERRCODE = '23514';
    END IF;

    IF NEW.expected_region_count > v_meta.region_limit THEN
      RAISE EXCEPTION 'tier_scheduling_limit' USING ERRCODE = '23514';
    END IF;

    SELECT count(*) INTO v_invalid_region
      FROM jsonb_array_elements_text(NEW.expected_regions::jsonb) r
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(v_meta.allowed_region_ids::jsonb) a WHERE a = r
     );

    IF v_invalid_region > 0 THEN
      RAISE EXCEPTION 'tier_scheduling_limit' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER tier_check_run_insert
BEFORE INSERT ON {{schema}}.check_runs
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tier_check_run_insert_func();

-- Tier active notification destinations view
CREATE OR REPLACE VIEW {{schema}}.tier_active_notification_services AS
SELECT *
FROM {{schema}}.notification_services
WHERE enabled = 1 AND provider IN ('telegram', 'discord')
ORDER BY created_at, id
LIMIT COALESCE((SELECT notification_destination_limit FROM {{schema}}.workspace_metadata WHERE id = 1), 1000000);

-- Delivery lease guard trigger
CREATE OR REPLACE FUNCTION {{schema}}.tier_notification_delivery_lease_func()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'sending' THEN
    IF EXISTS (SELECT 1 FROM {{schema}}.workspace_metadata WHERE id = 1) THEN
      IF NOT EXISTS (
        SELECT 1 FROM {{schema}}.tier_schedulable_monitors WHERE id = NEW.monitor_id
      ) OR NOT EXISTS (
        SELECT 1 FROM {{schema}}.tier_active_notification_services WHERE id = NEW.notification_service_id
      ) THEN
        RAISE EXCEPTION 'tier_notification_delivery_limit' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER tier_notification_delivery_lease
BEFORE UPDATE OF status ON {{schema}}.notification_deliveries
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tier_notification_delivery_lease_func();
