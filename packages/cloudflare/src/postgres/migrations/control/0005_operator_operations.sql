-- Control-plane migration 0005: Operator operations
-- Tables: scheduling_controls, coordinator_runtime_health

CREATE TABLE IF NOT EXISTS {{schema}}.scheduling_controls (
  scope TEXT PRIMARY KEY NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS {{schema}}.coordinator_runtime_health (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
