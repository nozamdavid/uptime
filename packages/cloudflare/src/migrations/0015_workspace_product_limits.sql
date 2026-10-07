ALTER TABLE workspace_metadata ADD COLUMN monitor_limit INTEGER NOT NULL DEFAULT 3
  CHECK (monitor_limit BETWEEN 0 AND 1000);
ALTER TABLE workspace_metadata ADD COLUMN region_limit INTEGER NOT NULL DEFAULT 3
  CHECK (region_limit BETWEEN 1 AND 9);
ALTER TABLE workspace_metadata ADD COLUMN allowed_region_ids TEXT NOT NULL DEFAULT '["eu-west","us-east","asia"]'
  CHECK (json_valid(allowed_region_ids) AND json_type(allowed_region_ids) = 'array'
    AND json_array_length(allowed_region_ids) BETWEEN 1 AND 9);

CREATE TRIGGER workspace_metadata_limits_validate_insert
BEFORE INSERT ON workspace_metadata
WHEN NEW.region_limit > json_array_length(NEW.allowed_region_ids)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.allowed_region_ids)
    WHERE type <> 'text' OR value NOT IN (
      'us-east','us-west','canada-central','eu-west','eu-north','eu-south',
      'asia','asia-east','asia-south'
    )
  )
  OR (SELECT count(DISTINCT value) FROM json_each(NEW.allowed_region_ids))
     <> json_array_length(NEW.allowed_region_ids)
BEGIN SELECT RAISE(ABORT, 'invalid_workspace_product_limits'); END;

CREATE TRIGGER workspace_metadata_limits_validate_update
BEFORE UPDATE OF monitor_limit, region_limit, allowed_region_ids ON workspace_metadata
WHEN NEW.region_limit > json_array_length(NEW.allowed_region_ids)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.allowed_region_ids)
    WHERE type <> 'text' OR value NOT IN (
      'us-east','us-west','canada-central','eu-west','eu-north','eu-south',
      'asia','asia-east','asia-south'
    )
  )
  OR (SELECT count(DISTINCT value) FROM json_each(NEW.allowed_region_ids))
     <> json_array_length(NEW.allowed_region_ids)
BEGIN SELECT RAISE(ABORT, 'invalid_workspace_product_limits'); END;

DROP TRIGGER IF EXISTS free_monitor_quota_insert;
CREATE TRIGGER free_monitor_quota_insert
BEFORE INSERT ON monitors
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (SELECT count(*) FROM monitors) >=
     (SELECT monitor_limit FROM workspace_metadata WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'free_monitor_limit'); END;

DROP TRIGGER IF EXISTS free_region_quota_insert;
CREATE TRIGGER free_region_quota_insert
BEFORE INSERT ON monitor_regions
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (SELECT count(*) FROM monitor_regions WHERE monitor_id = NEW.monitor_id) >=
     (SELECT region_limit FROM workspace_metadata WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'free_region_limit'); END;

CREATE TRIGGER workspace_allowed_region_insert
BEFORE INSERT ON monitor_regions
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND NOT EXISTS (
   SELECT 1 FROM json_each((SELECT allowed_region_ids FROM workspace_metadata WHERE id = 1))
   WHERE value = NEW.region_id
 )
BEGIN SELECT RAISE(ABORT, 'free_region_unavailable'); END;

CREATE TRIGGER workspace_region_quota_update
BEFORE UPDATE ON monitor_regions
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND (SELECT count(*) FROM monitor_regions
      WHERE monitor_id = NEW.monitor_id
        AND (NEW.monitor_id <> OLD.monitor_id OR region_id <> OLD.region_id)) >=
     (SELECT region_limit FROM workspace_metadata WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'free_region_limit'); END;

CREATE TRIGGER workspace_allowed_region_update
BEFORE UPDATE ON monitor_regions
WHEN (SELECT plan FROM workspace_metadata WHERE id = 1) = 'free'
 AND NOT EXISTS (
   SELECT 1 FROM json_each((SELECT allowed_region_ids FROM workspace_metadata WHERE id = 1))
   WHERE value = NEW.region_id
 )
BEGIN SELECT RAISE(ABORT, 'free_region_unavailable'); END;
