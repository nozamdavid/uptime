PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  did TEXT PRIMARY KEY NOT NULL,
  handle TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL,
  did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, did)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  owner_did TEXT NOT NULL UNIQUE REFERENCES users(did),
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting_for_capacity' CHECK (state IN ('active','suspended','waiting_for_capacity','deleting','deleted')),
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan = 'free'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  next_dispatch_at TEXT,
  execution_lease_token TEXT,
  execution_lease_until TEXT
);
CREATE TABLE IF NOT EXISTS tenant_slots (
  binding_name TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT UNIQUE,
  database_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('available','assigned','deleting'))
);
CREATE TABLE IF NOT EXISTS workspace_usage_daily (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, day)
);
CREATE TABLE IF NOT EXISTS service_controls (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_budget_usd REAL NOT NULL DEFAULT 20,
  admission_open INTEGER NOT NULL DEFAULT 1,
  max_workspaces INTEGER NOT NULL DEFAULT 10,
  external_monthly_cost_usd REAL NOT NULL DEFAULT 0
);
INSERT INTO service_controls(id) VALUES (1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invitee_did TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('maintainer','viewer')),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, invitee_did)
);
CREATE TABLE IF NOT EXISTS request_budgets (
  key TEXT PRIMARY KEY NOT NULL,
  window_started_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT,
  event TEXT NOT NULL,
  actor_did TEXT,
  created_at TEXT NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details))
);
CREATE TABLE IF NOT EXISTS dispatch_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  last_error TEXT,
  UNIQUE (workspace_id, scheduled_at)
);
CREATE INDEX IF NOT EXISTS dispatch_outbox_due_idx ON dispatch_outbox(status, next_attempt_at);
CREATE INDEX workspaces_dispatch_idx ON workspaces(state,next_dispatch_at);
CREATE INDEX request_budgets_window_idx ON request_budgets(window_started_at);
CREATE INDEX memberships_did_idx ON memberships(did,workspace_id);

CREATE TABLE IF NOT EXISTS atproto_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL, encrypted_payload TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atproto_oauth_states_expires_idx ON atproto_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS atproto_oauth_sessions (
  did TEXT PRIMARY KEY NOT NULL, encrypted_payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS atproto_oauth_locks (
  name TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL, lease_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atproto_oauth_locks_lease_idx ON atproto_oauth_locks(lease_until);
CREATE TABLE IF NOT EXISTS atproto_login_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL, did TEXT NOT NULL, handle TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atproto_login_sessions_expires_idx ON atproto_login_sessions(expires_at);
