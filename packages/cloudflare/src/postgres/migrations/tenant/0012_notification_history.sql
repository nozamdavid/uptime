-- Tenant migration 0012: Notification history
-- Table: notification_history + paging and retention indexes

CREATE TABLE IF NOT EXISTS {{schema}}.notification_history (
  id TEXT PRIMARY KEY NOT NULL,
  notification_service_id TEXT NOT NULL REFERENCES {{schema}}.notification_services (id) ON DELETE CASCADE,
  monitor_id TEXT REFERENCES {{schema}}.monitors (id) ON DELETE SET NULL,
  monitor_name TEXT NOT NULL,
  monitor_url TEXT,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CONSTRAINT notification_history_kind CHECK (kind IN ('outage', 'recovery', 'reminder', 'test')),
  status TEXT NOT NULL CONSTRAINT notification_history_status CHECK (status IN ('sent', 'failed')),
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  external_url TEXT,
  error TEXT,
  preview TEXT NOT NULL DEFAULT '{}' CONSTRAINT notification_history_preview_json CHECK (preview IS JSON)
);

CREATE INDEX IF NOT EXISTS notification_history_service_page_idx
  ON {{schema}}.notification_history (notification_service_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS notification_history_retention_idx
  ON {{schema}}.notification_history (created_at, id);
