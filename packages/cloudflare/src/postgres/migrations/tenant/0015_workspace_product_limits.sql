-- Tenant migration 0015: Workspace product limits
-- Adds monitor_limit, region_limit, allowed_region_ids to workspace_metadata
-- Replaces fixed free quotas with configurable workspace limits and MVCC singleton locking

ALTER TABLE {{schema}}.workspace_metadata
  ADD COLUMN IF NOT EXISTS monitor_limit INTEGER NOT NULL DEFAULT 3 CHECK (monitor_limit BETWEEN 0 AND 1000);

ALTER TABLE {{schema}}.workspace_metadata
  ADD COLUMN IF NOT EXISTS region_limit INTEGER NOT NULL DEFAULT 3 CHECK (region_limit BETWEEN 1 AND 9);

ALTER TABLE {{schema}}.workspace_metadata
  ADD COLUMN IF NOT EXISTS allowed_region_ids TEXT NOT NULL DEFAULT '["eu-west","us-east","asia"]'
    CHECK (allowed_region_ids IS JSON AND jsonb_typeof(allowed_region_ids::jsonb) = 'array' AND jsonb_array_length(allowed_region_ids::jsonb) BETWEEN 1 AND 9);

CREATE OR REPLACE FUNCTION {{schema}}.workspace_metadata_limits_validate_func()
RETURNS trigger AS $$
DECLARE
  v_len integer;
  v_distinct integer;
  v_invalid integer;
BEGIN
  v_len := jsonb_array_length(NEW.allowed_region_ids::jsonb);
  IF NEW.region_limit > v_len THEN
    RAISE EXCEPTION 'invalid_workspace_product_limits' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_invalid
    FROM jsonb_array_elements(NEW.allowed_region_ids::jsonb) elem
   WHERE jsonb_typeof(elem) <> 'string'
      OR elem #>> '{}' NOT IN (
        'us-east','us-west','canada-central','eu-west','eu-north','eu-south',
        'asia','asia-east','asia-south'
      );

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'invalid_workspace_product_limits' USING ERRCODE = '23514';
  END IF;

  SELECT count(DISTINCT elem #>> '{}') INTO v_distinct
    FROM jsonb_array_elements(NEW.allowed_region_ids::jsonb) elem;

  IF v_distinct <> v_len THEN
    RAISE EXCEPTION 'invalid_workspace_product_limits' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER workspace_metadata_limits_validate_insert
BEFORE INSERT ON {{schema}}.workspace_metadata
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_metadata_limits_validate_func();

CREATE OR REPLACE TRIGGER workspace_metadata_limits_validate_update
BEFORE UPDATE OF monitor_limit, region_limit, allowed_region_ids ON {{schema}}.workspace_metadata
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_metadata_limits_validate_func();

-- Replaced free_monitor_quota_insert checking configurable limit
CREATE OR REPLACE FUNCTION {{schema}}.free_monitor_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
  v_limit INTEGER;
BEGIN
  SELECT plan, monitor_limit INTO v_plan, v_limit
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF (SELECT count(*) FROM {{schema}}.monitors) >= v_limit THEN
      RAISE EXCEPTION 'free_monitor_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replaced free_region_quota_insert checking configurable limit
CREATE OR REPLACE FUNCTION {{schema}}.free_region_quota_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
  v_limit INTEGER;
BEGIN
  SELECT plan, region_limit INTO v_plan, v_limit
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF (SELECT count(*) FROM {{schema}}.monitor_regions WHERE monitor_id = NEW.monitor_id) >= v_limit THEN
      RAISE EXCEPTION 'free_region_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION {{schema}}.workspace_allowed_region_insert_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
  v_allowed JSONB;
BEGIN
  SELECT plan, allowed_region_ids::jsonb INTO v_plan, v_allowed
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_allowed) AS val WHERE val = NEW.region_id
    ) THEN
      RAISE EXCEPTION 'free_region_unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER workspace_allowed_region_insert
BEFORE INSERT ON {{schema}}.monitor_regions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_allowed_region_insert_func();

CREATE OR REPLACE FUNCTION {{schema}}.workspace_region_quota_update_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
  v_limit INTEGER;
BEGIN
  SELECT plan, region_limit INTO v_plan, v_limit
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF (
      SELECT count(*) FROM {{schema}}.monitor_regions
       WHERE monitor_id = NEW.monitor_id
         AND (NEW.monitor_id <> OLD.monitor_id OR region_id <> OLD.region_id)
    ) >= v_limit THEN
      RAISE EXCEPTION 'free_region_limit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER workspace_region_quota_update
BEFORE UPDATE ON {{schema}}.monitor_regions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_region_quota_update_func();

CREATE OR REPLACE FUNCTION {{schema}}.workspace_allowed_region_update_func()
RETURNS trigger AS $$
DECLARE
  v_plan TEXT;
  v_allowed JSONB;
BEGIN
  SELECT plan, allowed_region_ids::jsonb INTO v_plan, v_allowed
    FROM {{schema}}.workspace_metadata WHERE id = 1 FOR UPDATE;
  IF v_plan = 'free' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_allowed) AS val WHERE val = NEW.region_id
    ) THEN
      RAISE EXCEPTION 'free_region_unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER workspace_allowed_region_update
BEFORE UPDATE ON {{schema}}.monitor_regions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_allowed_region_update_func();
