-- Control-plane migration 0003: Interest signups
-- Table: interest_signups

CREATE TABLE IF NOT EXISTS {{schema}}.interest_signups (
  did TEXT PRIMARY KEY NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  channel TEXT
);

ALTER TABLE {{schema}}.interest_signups ADD COLUMN IF NOT EXISTS channel TEXT;

CREATE INDEX IF NOT EXISTS interest_signups_created_idx
  ON {{schema}}.interest_signups (created_at DESC, did);
