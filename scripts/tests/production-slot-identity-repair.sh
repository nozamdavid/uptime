#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
repair="$(cat "$root/docs/deployment/production-slot-identity-repair-2026-10-05.sql")"
seed="$(sed '/^), guard AS (/,$d' <<< "$repair")"
seed+=") INSERT INTO tenant_slots SELECT binding_name,old_id,13,CASE WHEN binding_name='TENANT_DB_000' THEN 'assigned' ELSE 'available' END,CASE WHEN binding_name='TENANT_DB_000' THEN 'a8965287-71af-4afd-8786-c3fb33c54a74' ELSE NULL END FROM expected;"
fixture="CREATE TABLE tenant_slots(binding_name TEXT PRIMARY KEY,database_id TEXT,schema_version INTEGER,status TEXT,workspace_id TEXT UNIQUE);
CREATE TABLE tenant_slot_controls(binding_name TEXT PRIMARY KEY,admission_enabled INTEGER);
CREATE TABLE workspaces(id TEXT,owner_did TEXT,state TEXT,execution_lease_token TEXT,execution_lease_until TEXT);
CREATE TABLE memberships(workspace_id TEXT,did TEXT,role TEXT);
INSERT INTO workspaces VALUES('a8965287-71af-4afd-8786-c3fb33c54a74','did:plc:lmkzmvv6sdxntwtyxpg7fqqq','active','slot-identity-repair:20f90bd2-b6d2-4440-b6b3-3bcff6dbbb88',strftime('%Y-%m-%dT%H:%M:%fZ','now','+16 minutes'));
INSERT INTO memberships VALUES('a8965287-71af-4afd-8786-c3fb33c54a74','did:plc:lmkzmvv6sdxntwtyxpg7fqqq','owner');
$seed
INSERT INTO tenant_slot_controls SELECT binding_name,0 FROM tenant_slots WHERE binding_name<>'TENANT_DB_000';"
check() {
  local scenario="$1" mutation="$2" expected="$3" actual
  actual="$(sqlite3 :memory: "$fixture $mutation $repair SELECT changes();")"
  [[ "$actual" == "$expected" ]] || { printf '%s failed: %s\n' "$scenario" "$actual" >&2; exit 1; }
}
check success '' 10
check conflicting_identity "UPDATE tenant_slots SET database_id='conflict' WHERE binding_name='TENANT_DB_004';" 0
check concurrent_assignment "UPDATE tenant_slots SET status='assigned',workspace_id='another-workspace' WHERE binding_name='TENANT_DB_004';" 0
check lost_hold "UPDATE tenant_slot_controls SET admission_enabled=1 WHERE binding_name='TENANT_DB_004';" 0
check expired_lease "UPDATE workspaces SET execution_lease_until='2000-01-01T00:00:00.000Z';" 0
check wrong_lease "UPDATE workspaces SET execution_lease_token='another-token';" 0
check owner_changed "UPDATE memberships SET role='member';" 0
printf '%s\n' 'production slot identity repair: 7 SQLite guard checks passed'
