-- Control-plane migration 0009: Native PostgreSQL tenant registry
-- Table: postgres_tenant_registry for multi-tenant schema isolation

CREATE TABLE IF NOT EXISTS {{schema}}.postgres_tenant_registry (
  source_database_id TEXT PRIMARY KEY,
  workspace_id TEXT UNIQUE REFERENCES {{schema}}.workspaces(id),
  schema_name TEXT NOT NULL UNIQUE CHECK (schema_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  status TEXT NOT NULL CHECK (status IN ('available', 'assigned', 'quarantined', 'deleting')),
  CHECK ((status = 'assigned' AND workspace_id IS NOT NULL) OR status <> 'assigned'),
  CHECK (status <> 'available' OR workspace_id IS NULL),
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS postgres_tenant_registry_status_idx
  ON {{schema}}.postgres_tenant_registry (status);

-- Assignment is a separate, verified manifest import after data and markers exist.
CREATE OR REPLACE FUNCTION {{schema}}.postgres_tenant_source_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.source_database_id <> OLD.source_database_id OR NEW.schema_name <> OLD.schema_name THEN
    RAISE EXCEPTION 'immutable_tenant_source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER postgres_tenant_source_immutable
BEFORE UPDATE ON {{schema}}.postgres_tenant_registry
FOR EACH ROW EXECUTE FUNCTION {{schema}}.postgres_tenant_source_immutable();
