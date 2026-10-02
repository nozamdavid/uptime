CREATE TABLE IF NOT EXISTS interest_signups (
  did TEXT PRIMARY KEY NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interest_signups_created_idx ON interest_signups(created_at DESC, did);
