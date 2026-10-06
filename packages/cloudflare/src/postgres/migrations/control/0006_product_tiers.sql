-- Control-plane migration 0006: Product tiers & catalog
-- Tables: product_catalog_revisions, product_catalog_current, workspace_tier_assignments
-- View: workspace_seat_limits
-- Triggers: catalog immutability, tier assignment validation, MVCC seat quota guards

CREATE TABLE IF NOT EXISTS {{schema}}.product_catalog_revisions (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  parent_revision INTEGER NOT NULL UNIQUE CHECK (parent_revision >= 0),
  catalog TEXT NOT NULL CHECK (catalog IS JSON),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION {{schema}}.product_catalog_revision_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_catalog_revision' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER product_catalog_revision_immutable_update
BEFORE UPDATE ON {{schema}}.product_catalog_revisions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.product_catalog_revision_immutable();

CREATE OR REPLACE TRIGGER product_catalog_revision_immutable_delete
BEFORE DELETE ON {{schema}}.product_catalog_revisions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.product_catalog_revision_immutable();

CREATE TABLE IF NOT EXISTS {{schema}}.product_catalog_current (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL REFERENCES {{schema}}.product_catalog_revisions(revision)
);

CREATE TABLE IF NOT EXISTS {{schema}}.workspace_tier_assignments (
  workspace_id TEXT PRIMARY KEY REFERENCES {{schema}}.workspaces(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL,
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  legacy_exempt INTEGER NOT NULL DEFAULT 0 CHECK (legacy_exempt IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO {{schema}}.workspace_tier_assignments(workspace_id, tier_id, catalog_revision, generation, legacy_exempt, updated_at)
SELECT workspace_id, 'free', 0, 1, 1, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM {{schema}}.tenant_slots
WHERE workspace_id IS NOT NULL AND binding_name IN ('STAGING_IMPORTED_DB', 'PRODUCTION_IMPORTED_DB', 'LEGACY_MAIN_DB')
ON CONFLICT (workspace_id) DO NOTHING;

CREATE OR REPLACE FUNCTION {{schema}}.workspace_tier_assignment_validate()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.generation <= OLD.generation THEN
    RAISE EXCEPTION 'invalid_tier_assignment' USING ERRCODE = '23514';
  END IF;

  IF NEW.catalog_revision = 0 AND NEW.tier_id <> 'free' THEN
    RAISE EXCEPTION 'invalid_tier_assignment' USING ERRCODE = '23514';
  END IF;

  IF NEW.catalog_revision > 0 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM {{schema}}.product_catalog_revisions r,
           jsonb_array_elements(r.catalog::jsonb->'plans') p
      WHERE r.revision = NEW.catalog_revision
        AND p->>'id' = NEW.tier_id
    ) THEN
      RAISE EXCEPTION 'invalid_tier_assignment' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER workspace_tier_assignment_insert
BEFORE INSERT ON {{schema}}.workspace_tier_assignments
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_tier_assignment_validate();

CREATE OR REPLACE TRIGGER workspace_tier_assignment_update
BEFORE UPDATE ON {{schema}}.workspace_tier_assignments
FOR EACH ROW EXECUTE FUNCTION {{schema}}.workspace_tier_assignment_validate();

CREATE OR REPLACE VIEW {{schema}}.workspace_seat_limits AS
SELECT w.id AS workspace_id,
  CASE
    WHEN a.legacy_exempt = 1 OR EXISTS (
      SELECT 1 FROM {{schema}}.tenant_slots
      WHERE workspace_id = w.id AND binding_name IN ('STAGING_IMPORTED_DB', 'PRODUCTION_IMPORTED_DB', 'LEGACY_MAIN_DB')
    ) THEN 1000000
    WHEN a.workspace_id IS NULL OR (a.catalog_revision = 0 AND a.tier_id = 'free') THEN 3
    ELSE COALESCE((
      SELECT (p->'entitlements'->>'seats')::integer
      FROM {{schema}}.product_catalog_revisions r,
           jsonb_array_elements(r.catalog::jsonb->'plans') p
      WHERE r.revision = a.catalog_revision AND p->>'id' = a.tier_id
      LIMIT 1
    ), 0)
  END AS seats
FROM {{schema}}.workspaces w
LEFT JOIN {{schema}}.workspace_tier_assignments a ON a.workspace_id = w.id;

CREATE OR REPLACE FUNCTION {{schema}}.tier_invitation_quota_guard()
RETURNS trigger AS $$
DECLARE
  v_seats integer;
  v_count integer;
BEGIN
  -- Lock workspace row to prevent concurrent seat over-allocation
  PERFORM 1 FROM {{schema}}.workspaces WHERE id = NEW.workspace_id FOR NO KEY UPDATE;

  SELECT seats INTO v_seats
    FROM {{schema}}.workspace_seat_limits
   WHERE workspace_id = NEW.workspace_id;

  IF v_seats IS NULL THEN
    v_seats := 3;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT (
      (SELECT count(*) FROM {{schema}}.memberships WHERE workspace_id = NEW.workspace_id)
      + (SELECT count(*) FROM {{schema}}.workspace_invitations
          WHERE workspace_id = NEW.workspace_id
            AND id <> OLD.id
            AND created_at::timestamptz > NEW.created_at::timestamptz - INTERVAL '7 days')
    ) INTO v_count;
  ELSE
    SELECT (
      (SELECT count(*) FROM {{schema}}.memberships WHERE workspace_id = NEW.workspace_id)
      + (SELECT count(*) FROM {{schema}}.workspace_invitations
          WHERE workspace_id = NEW.workspace_id
            AND invitee_did <> NEW.invitee_did
            AND created_at::timestamptz > NEW.created_at::timestamptz - INTERVAL '7 days')
    ) INTO v_count;
  END IF;

  IF v_count >= v_seats THEN
    RAISE EXCEPTION 'workspace_seat_limit' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER tier_invitation_quota_insert
BEFORE INSERT ON {{schema}}.workspace_invitations
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tier_invitation_quota_guard();

CREATE OR REPLACE TRIGGER tier_invitation_quota_update
BEFORE UPDATE ON {{schema}}.workspace_invitations
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tier_invitation_quota_guard();

CREATE OR REPLACE FUNCTION {{schema}}.tier_membership_quota_guard()
RETURNS trigger AS $$
DECLARE
  v_seats integer;
  v_count integer;
BEGIN
  -- Lock workspace row to prevent concurrent seat over-allocation
  PERFORM 1 FROM {{schema}}.workspaces WHERE id = NEW.workspace_id FOR NO KEY UPDATE;

  SELECT seats INTO v_seats
    FROM {{schema}}.workspace_seat_limits
   WHERE workspace_id = NEW.workspace_id;

  IF v_seats IS NULL THEN
    v_seats := 3;
  END IF;

  SELECT (
    (SELECT count(*) FROM {{schema}}.memberships
      WHERE workspace_id = NEW.workspace_id AND did <> NEW.did
        AND did <> CASE WHEN TG_OP = 'UPDATE' AND OLD.workspace_id = NEW.workspace_id THEN OLD.did ELSE NEW.did END)
    + (SELECT count(*) FROM {{schema}}.workspace_invitations
        WHERE workspace_id = NEW.workspace_id
          AND invitee_did <> NEW.did
          AND created_at::timestamptz > NEW.created_at::timestamptz - INTERVAL '7 days')
  ) INTO v_count;

  IF v_count >= v_seats THEN
    RAISE EXCEPTION 'workspace_seat_limit' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER tier_membership_quota_insert
BEFORE INSERT ON {{schema}}.memberships
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tier_membership_quota_guard();

CREATE OR REPLACE TRIGGER tier_membership_quota_update
BEFORE UPDATE OF workspace_id, did ON {{schema}}.memberships
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tier_membership_quota_guard();
