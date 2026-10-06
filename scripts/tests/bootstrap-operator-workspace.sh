#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -r "$scratch"' EXIT
export BOOTSTRAP_TEST_PROD_CONTROL="$scratch/production-control.sqlite"
export BOOTSTRAP_TEST_PROD_MAIN="$scratch/production-main.sqlite"
export BOOTSTRAP_TEST_CALLS="$scratch/calls"
for migration in "$root/packages/cloudflare/src/control-migrations/"*.sql; do sqlite3 "$BOOTSTRAP_TEST_PROD_CONTROL" < "$migration"; done
git() { printf '%s\n' "${BOOTSTRAP_TEST_BRANCH:-codex/product-release-plan}"; }
uuidgen() { printf '%s\n' '00000000-0000-4000-8000-000000000002'; }
pnpm() {
  local database="" sql="" previous="" argument rows
  printf '%s\n' "$*" >> "$BOOTSTRAP_TEST_CALLS"
  for argument in "$@"; do
    [[ "$previous" != execute ]] || database="$argument"
    [[ "$previous" != --command ]] || sql="$argument"
    previous="$argument"
  done
  case "$database" in
    CONTROL_DB) database="$BOOTSTRAP_TEST_PROD_CONTROL" ;;
    PRODUCTION_IMPORTED_DB) database="$BOOTSTRAP_TEST_PROD_MAIN" ;;
    *) return 1 ;;
  esac
  rows="$(sqlite3 -json "$database" "$sql")" || return 1
  printf '[{"success":true,"results":%s}]\n' "${rows:-[]}"
}
export -f git uuidgen pnpm

# Staging D1 is retired: both the default branch target and an explicit request fail before any D1 call.
if "$root/scripts/bootstrap-operator-workspace.sh" --dry-run >/dev/null 2>&1; then exit 1; fi
if "$root/scripts/bootstrap-operator-workspace.sh" --environment staging >/dev/null 2>&1; then exit 1; fi
if "$root/scripts/bootstrap-operator-workspace.sh" --environment production >/dev/null 2>&1; then exit 1; fi
[[ ! -f "$BOOTSTRAP_TEST_CALLS" ]]

sqlite3 "$BOOTSTRAP_TEST_PROD_CONTROL" <<'SQL'
INSERT INTO users(did,handle,state,created_at,updated_at,last_seen_at)
VALUES('did:plc:lmkzmvv6sdxntwtyxpg7fqqq','noz.am','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO workspaces(id,owner_did,name,state,plan,created_at,updated_at,last_seen_at)
VALUES('00000000-0000-4000-8000-000000000002','did:plc:lmkzmvv6sdxntwtyxpg7fqqq','Existing workspace','active','free','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO memberships(workspace_id,did,role,created_at)
VALUES('00000000-0000-4000-8000-000000000002','did:plc:lmkzmvv6sdxntwtyxpg7fqqq','owner','2026-01-01T00:00:00.000Z');
INSERT INTO tenant_slots(binding_name,workspace_id,database_id,schema_version,status)
VALUES('PRODUCTION_IMPORTED_DB','00000000-0000-4000-8000-000000000002','17c009df-5b56-44cc-9776-73e0f1775b0f',12,'assigned');
SQL
sqlite3 "$BOOTSTRAP_TEST_PROD_MAIN" <<'SQL'
CREATE TABLE production_workspace_identity(id INTEGER PRIMARY KEY CHECK(id=1),workspace_id TEXT NOT NULL,database_id TEXT NOT NULL);
INSERT INTO production_workspace_identity VALUES(1,'00000000-0000-4000-8000-000000000002','17c009df-5b56-44cc-9776-73e0f1775b0f');
SQL
export BOOTSTRAP_TEST_BRANCH=main
"$root/scripts/bootstrap-operator-workspace.sh" --environment production --dry-run >/dev/null
[[ ! -f "$BOOTSTRAP_TEST_CALLS" ]]
: > "$BOOTSTRAP_TEST_CALLS"
"$root/scripts/bootstrap-operator-workspace.sh" --environment production >/dev/null
[[ "$(sqlite3 "$BOOTSTRAP_TEST_PROD_CONTROL" 'SELECT count(*) FROM workspaces')" == 1 ]]
[[ "$(sqlite3 "$BOOTSTRAP_TEST_PROD_CONTROL" "SELECT binding_name || ':' || status FROM tenant_slots")" == PRODUCTION_IMPORTED_DB:assigned ]]
[[ "$(sqlite3 "$BOOTSTRAP_TEST_PROD_MAIN" 'SELECT count(*) FROM production_workspace_identity')" == 1 ]]
! grep -q 'INSERT INTO workspaces\|UPDATE tenant_slots\|workspace_metadata' "$BOOTSTRAP_TEST_CALLS"

sqlite3 "$BOOTSTRAP_TEST_PROD_CONTROL" "UPDATE tenant_slots SET workspace_id=NULL,status='available' WHERE binding_name='PRODUCTION_IMPORTED_DB';"
: > "$BOOTSTRAP_TEST_CALLS"
if "$root/scripts/bootstrap-operator-workspace.sh" --environment production >/dev/null 2>&1; then exit 1; fi
[[ "$(sqlite3 "$BOOTSTRAP_TEST_PROD_CONTROL" 'SELECT count(*) FROM workspaces')" == 1 ]]
[[ "$(sqlite3 "$BOOTSTRAP_TEST_PROD_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='PRODUCTION_IMPORTED_DB'")" == available ]]
! grep -q 'INSERT INTO workspaces\|UPDATE tenant_slots\|workspace_metadata' "$BOOTSTRAP_TEST_CALLS"
printf 'bootstrap-operator-workspace tests passed\n'
