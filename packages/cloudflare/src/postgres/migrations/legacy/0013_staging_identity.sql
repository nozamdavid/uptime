-- Preserve the actual imported D1 marker, with no hosted quota metadata.
CREATE TABLE IF NOT EXISTS {{schema}}.staging_workspace_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id TEXT NOT NULL,
  database_id TEXT NOT NULL
);
