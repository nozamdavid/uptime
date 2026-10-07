-- Control-plane migration 0004: Workspace product limits
-- Table: workspace_product_limits + validation triggers

CREATE TABLE IF NOT EXISTS {{schema}}.workspace_product_limits (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES {{schema}}.workspaces(id) ON DELETE CASCADE,
  monitors INTEGER NOT NULL DEFAULT 3 CHECK (monitors BETWEEN 0 AND 1000),
  regions INTEGER NOT NULL DEFAULT 3 CHECK (regions BETWEEN 1 AND 9),
  allowed_region_ids TEXT NOT NULL DEFAULT '["eu-west","us-east","asia"]'
    CHECK (allowed_region_ids IS JSON AND jsonb_typeof(allowed_region_ids::jsonb) = 'array'
      AND jsonb_array_length(allowed_region_ids::jsonb) BETWEEN 1 AND 9),
  updated_at TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION {{schema}}.workspace_product_limits_validate()
RETURNS trigger AS $$
DECLARE
  v_len integer;
  v_distinct integer;
  v_invalid integer;
BEGIN
  v_len := jsonb_array_length(NEW.allowed_region_ids::jsonb);
  IF NEW.regions > v_len THEN
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

CREATE OR REPLACE TRIGGER workspace_product_limits_validate_insert
BEFORE INSERT ON {{schema}}.workspace_product_limits
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_product_limits_validate();

CREATE OR REPLACE TRIGGER workspace_product_limits_validate_update
BEFORE UPDATE OF monitors, regions, allowed_region_ids ON {{schema}}.workspace_product_limits
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_product_limits_validate();
