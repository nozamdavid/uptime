CREATE TABLE IF NOT EXISTS workspace_product_limits (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  monitors INTEGER NOT NULL DEFAULT 3 CHECK (monitors BETWEEN 0 AND 1000),
  regions INTEGER NOT NULL DEFAULT 3 CHECK (regions BETWEEN 1 AND 9),
  allowed_region_ids TEXT NOT NULL DEFAULT '["eu-west","us-east","asia"]'
    CHECK (json_valid(allowed_region_ids) AND json_type(allowed_region_ids) = 'array'
      AND json_array_length(allowed_region_ids) BETWEEN 1 AND 9),
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS workspace_product_limits_validate_insert
BEFORE INSERT ON workspace_product_limits
WHEN NEW.regions > json_array_length(NEW.allowed_region_ids)
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

CREATE TRIGGER IF NOT EXISTS workspace_product_limits_validate_update
BEFORE UPDATE OF monitors, regions, allowed_region_ids ON workspace_product_limits
WHEN NEW.regions > json_array_length(NEW.allowed_region_ids)
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
