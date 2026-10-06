CREATE TABLE scheduling_controls (
  scope TEXT PRIMARY KEY NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0,1)),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX dispatch_outbox_workspace_pending_idx ON dispatch_outbox(workspace_id,status,created_at);
CREATE INDEX dispatch_outbox_pending_created_idx ON dispatch_outbox(status,created_at);
CREATE TABLE coordinator_runtime_health (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
