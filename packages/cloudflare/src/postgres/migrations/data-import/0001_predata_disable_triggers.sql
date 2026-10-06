-- Execute inside importPostgresData's transaction, never through the ledger.
-- Capture each existing user trigger and its exact O/D/R/A state. FK triggers stay on.
CREATE TEMP TABLE uptime_import_trigger_state (
  schema_name TEXT NOT NULL, table_name TEXT NOT NULL, trigger_name TEXT NOT NULL,
  enabled "char" NOT NULL, PRIMARY KEY (schema_name, table_name, trigger_name)
) ON COMMIT DROP;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '{{schema_name}}' AND c.relkind = 'r' ORDER BY c.relname
  LOOP
    EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', '{{schema_name}}', r.relname);
  END LOOP;
END;
$$;

INSERT INTO uptime_import_trigger_state
SELECT n.nspname, c.relname, t.tgname, t.tgenabled
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '{{schema_name}}' AND NOT t.tgisinternal;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM uptime_import_trigger_state ORDER BY table_name, trigger_name LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER %I', r.schema_name, r.table_name, r.trigger_name);
  END LOOP;
END;
$$;
