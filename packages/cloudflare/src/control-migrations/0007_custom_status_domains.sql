-- Custom status domains registry table and indexes for status page vanity domains
CREATE TABLE custom_status_domains (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status_page_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  provider_id TEXT,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('disabled', 'mock', 'cloudflare')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'active', 'deleting', 'delete_failed', 'deleted')),
  error_code TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  verified_at TEXT,
  recheck_due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Global canonical hostname uniqueness across all workspaces for non-deleted claims
CREATE UNIQUE INDEX IF NOT EXISTS custom_status_domains_hostname_active_idx
ON custom_status_domains(hostname)
WHERE deleted_at IS NULL;

-- Max one domain claim per status page for non-deleted claims
CREATE UNIQUE INDEX IF NOT EXISTS custom_status_domains_page_active_idx
ON custom_status_domains(workspace_id, status_page_id)
WHERE deleted_at IS NULL;

-- Efficient query index for listing by workspace
CREATE INDEX IF NOT EXISTS custom_status_domains_workspace_idx
ON custom_status_domains(workspace_id, status, created_at);

-- Ingress / gateway lookup index for public hostname resolution
CREATE INDEX IF NOT EXISTS custom_status_domains_resolve_idx
ON custom_status_domains(hostname, status)
WHERE deleted_at IS NULL;

-- Recheck deadline index for scheduled reconciliation
CREATE INDEX IF NOT EXISTS custom_status_domains_recheck_idx
ON custom_status_domains(status, recheck_due_at)
WHERE deleted_at IS NULL;
