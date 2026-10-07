-- Control-plane migration 0007: Custom status domains
-- Table: custom_status_domains + partial indexes + MVCC workspace lock

CREATE TABLE IF NOT EXISTS {{schema}}.custom_status_domains (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES {{schema}}.workspaces(id) ON DELETE CASCADE,
  status_page_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  provider_id TEXT,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('disabled', 'mock', 'cloudflare')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'active', 'deleting', 'delete_failed', 'deleted')),
  error_code TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (details_json IS JSON),
  verified_at TEXT,
  recheck_due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_status_domains_hostname_active_idx
  ON {{schema}}.custom_status_domains (hostname)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS custom_status_domains_page_active_idx
  ON {{schema}}.custom_status_domains (workspace_id, status_page_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS custom_status_domains_workspace_idx
  ON {{schema}}.custom_status_domains (workspace_id, status, created_at);

CREATE INDEX IF NOT EXISTS custom_status_domains_resolve_idx
  ON {{schema}}.custom_status_domains (hostname, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS custom_status_domains_recheck_idx
  ON {{schema}}.custom_status_domains (status, recheck_due_at)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION {{schema}}.custom_status_domains_lock_workspace()
RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM {{schema}}.workspaces WHERE id = NEW.workspace_id FOR NO KEY UPDATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER custom_status_domains_workspace_lock
BEFORE INSERT OR UPDATE OF workspace_id ON {{schema}}.custom_status_domains
FOR EACH ROW EXECUTE FUNCTION {{schema}}.custom_status_domains_lock_workspace();
