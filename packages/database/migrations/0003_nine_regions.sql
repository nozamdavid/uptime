-- Keep existing region values and historical rows intact; PostgreSQL enum values
-- are only appended. IF NOT EXISTS makes a manually-retried deploy safe.
ALTER TYPE region_id ADD VALUE IF NOT EXISTS 'us-west';
ALTER TYPE region_id ADD VALUE IF NOT EXISTS 'canada-central';
ALTER TYPE region_id ADD VALUE IF NOT EXISTS 'eu-north';
ALTER TYPE region_id ADD VALUE IF NOT EXISTS 'eu-south';
ALTER TYPE region_id ADD VALUE IF NOT EXISTS 'asia-east';
ALTER TYPE region_id ADD VALUE IF NOT EXISTS 'asia-south';

ALTER TABLE check_runs DROP CONSTRAINT IF EXISTS check_runs_region_count;
ALTER TABLE check_runs
  ADD CONSTRAINT check_runs_region_count CHECK (expected_region_count BETWEEN 1 AND 9);
