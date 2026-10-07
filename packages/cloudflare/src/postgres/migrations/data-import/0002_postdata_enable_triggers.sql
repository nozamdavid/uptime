-- Restore the exact captured state. Failure rolls back toggles and imported rows.
DO $$
DECLARE r RECORD; action TEXT;
BEGIN
  FOR r IN SELECT * FROM uptime_import_trigger_state ORDER BY table_name, trigger_name LOOP
    action := CASE r.enabled WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA'
      WHEN 'A' THEN 'ENABLE ALWAYS' ELSE 'ENABLE' END;
    EXECUTE format('ALTER TABLE %I.%I %s TRIGGER %I', r.schema_name, r.table_name, action, r.trigger_name);
  END LOOP;
END;
$$;
