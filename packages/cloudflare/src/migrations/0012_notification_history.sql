-- Immutable delivery attempts. Snapshot monitor details so history survives edits
-- and monitor deletion, while service deletion removes its private history.
CREATE TABLE notification_history (
  id TEXT PRIMARY KEY NOT NULL,
  notification_service_id TEXT NOT NULL REFERENCES notification_services (id) ON DELETE CASCADE,
  monitor_id TEXT REFERENCES monitors (id) ON DELETE SET NULL,
  monitor_name TEXT NOT NULL,
  monitor_url TEXT,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  external_url TEXT,
  error TEXT,
  preview TEXT NOT NULL DEFAULT '{}',
  CONSTRAINT notification_history_kind CHECK (kind IN ('outage', 'recovery', 'reminder', 'test')),
  CONSTRAINT notification_history_status CHECK (status IN ('sent', 'failed')),
  CONSTRAINT notification_history_preview_json CHECK (json_valid(preview))
);

CREATE INDEX notification_history_service_page_idx
  ON notification_history (notification_service_id, created_at DESC, id DESC);

CREATE INDEX notification_history_retention_idx
  ON notification_history (created_at, id);
