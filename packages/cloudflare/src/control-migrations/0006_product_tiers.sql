-- Legacy workspaces.plan remains free. Tier contracts live in separate tables.
CREATE TABLE product_catalog_revisions (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  parent_revision INTEGER NOT NULL UNIQUE CHECK (parent_revision >= 0),
  catalog TEXT NOT NULL CHECK (json_valid(catalog)),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL
);
CREATE TRIGGER product_catalog_revision_immutable_update BEFORE UPDATE ON product_catalog_revisions
BEGIN SELECT RAISE(ABORT, 'immutable_catalog_revision'); END;
CREATE TRIGGER product_catalog_revision_immutable_delete BEFORE DELETE ON product_catalog_revisions
BEGIN SELECT RAISE(ABORT, 'immutable_catalog_revision'); END;
CREATE TABLE product_catalog_current (
  id INTEGER PRIMARY KEY CHECK (id=1),
  revision INTEGER NOT NULL REFERENCES product_catalog_revisions(revision)
);
CREATE TABLE workspace_tier_assignments (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL,
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  legacy_exempt INTEGER NOT NULL DEFAULT 0 CHECK (legacy_exempt IN (0,1)),
  updated_at TEXT NOT NULL
);
-- Imported binding identities are registered separately; leave them exempt.
INSERT INTO workspace_tier_assignments(workspace_id,tier_id,catalog_revision,generation,legacy_exempt,updated_at)
SELECT workspace_id,'free',0,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tenant_slots
WHERE workspace_id IS NOT NULL AND binding_name IN ('STAGING_IMPORTED_DB','PRODUCTION_IMPORTED_DB','LEGACY_MAIN_DB');

CREATE TRIGGER workspace_tier_validate_insert BEFORE INSERT ON workspace_tier_assignments
WHEN (NEW.catalog_revision=0 AND NEW.tier_id<>'free') OR
 (NEW.catalog_revision>0 AND NOT EXISTS(SELECT 1 FROM product_catalog_revisions r,
   json_each(r.catalog,'$.plans') p WHERE r.revision=NEW.catalog_revision AND json_extract(p.value,'$.id')=NEW.tier_id))
BEGIN SELECT RAISE(ABORT,'invalid_tier_assignment'); END;
CREATE TRIGGER workspace_tier_validate_update BEFORE UPDATE ON workspace_tier_assignments
WHEN NEW.generation<=OLD.generation OR (NEW.catalog_revision=0 AND NEW.tier_id<>'free') OR
 (NEW.catalog_revision>0 AND NOT EXISTS(SELECT 1 FROM product_catalog_revisions r,
   json_each(r.catalog,'$.plans') p WHERE r.revision=NEW.catalog_revision AND json_extract(p.value,'$.id')=NEW.tier_id))
BEGIN SELECT RAISE(ABORT,'invalid_tier_assignment'); END;

CREATE VIEW workspace_seat_limits AS
SELECT w.id AS workspace_id, CASE WHEN a.legacy_exempt=1 OR EXISTS(
  SELECT 1 FROM tenant_slots WHERE workspace_id=w.id AND binding_name IN ('STAGING_IMPORTED_DB','PRODUCTION_IMPORTED_DB','LEGACY_MAIN_DB')
) THEN 1000000 WHEN a.workspace_id IS NULL OR (a.catalog_revision=0 AND a.tier_id='free') THEN 3
  ELSE COALESCE(json_extract(r.catalog,'$.plans[' || (
    SELECT key FROM json_each(r.catalog,'$.plans') WHERE json_extract(value,'$.id')=a.tier_id
  ) || '].entitlements.seats'),0) END AS seats
FROM workspaces w LEFT JOIN workspace_tier_assignments a ON a.workspace_id=w.id
LEFT JOIN product_catalog_revisions r ON r.revision=a.catalog_revision;

CREATE TRIGGER tier_invitation_quota_insert BEFORE INSERT ON workspace_invitations
WHEN (SELECT count(*) FROM memberships WHERE workspace_id=NEW.workspace_id) +
 (SELECT count(*) FROM workspace_invitations WHERE workspace_id=NEW.workspace_id
   AND invitee_did<>NEW.invitee_did AND julianday(created_at)>julianday(NEW.created_at)-7)
 >= (SELECT seats FROM workspace_seat_limits WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace_seat_limit'); END;
CREATE TRIGGER tier_invitation_quota_update BEFORE UPDATE ON workspace_invitations
WHEN (SELECT count(*) FROM memberships WHERE workspace_id=NEW.workspace_id) +
 (SELECT count(*) FROM workspace_invitations WHERE workspace_id=NEW.workspace_id
   AND id<>OLD.id AND julianday(created_at)>julianday(NEW.created_at)-7)
 >= (SELECT seats FROM workspace_seat_limits WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace_seat_limit'); END;
CREATE TRIGGER tier_membership_quota_insert BEFORE INSERT ON memberships
WHEN NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=NEW.workspace_id AND did=NEW.did)
 AND (SELECT count(*) FROM memberships WHERE workspace_id=NEW.workspace_id) +
 (SELECT count(*) FROM workspace_invitations WHERE workspace_id=NEW.workspace_id AND invitee_did<>NEW.did
   AND julianday(created_at)>julianday(NEW.created_at)-7)
 >= (SELECT seats FROM workspace_seat_limits WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace_seat_limit'); END;
