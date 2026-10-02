-- A canonical monitor owns one short, demand-triggered refresh cycle.
-- R2 objects are immutable; this row is the fenced commit pointer.
CREATE TABLE monitor_report_refresh (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle', 'building', 'starting', 'active')),
  ordinal INTEGER NOT NULL DEFAULT -1 CHECK (ordinal BETWEEN -1 AND 4),
  lease_until TEXT NOT NULL,
  object_key TEXT,
  generated_at TEXT,
  last_build_metrics TEXT
);
