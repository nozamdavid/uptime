#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export ADOPT_TEST_CONTROL="$scratch/control.sqlite"
export ADOPT_TEST_OLD="$scratch/old.sqlite"
export ADOPT_TEST_MAIN="$scratch/main.sqlite"
export ADOPT_TEST_CALLS="$scratch/calls"
workspace_id=00000000-0000-4000-8000-000000000002
old_database_id=00000000-0000-4000-8000-000000000001
main_database_id=17c009df-5b56-44cc-9776-73e0f1775b0f
operator_did=did:plc:lmkzmvv6sdxntwtyxpg7fqqq

initialize_fixture() {
  unset ADOPT_TEST_FAULT
  rm -f "$ADOPT_TEST_CONTROL" "$ADOPT_TEST_OLD" "$ADOPT_TEST_MAIN"
  for migration in "$root/packages/cloudflare/src/control-migrations/"*.sql; do
    sqlite3 "$ADOPT_TEST_CONTROL" < "$migration"
  done
  for migration in "$root/packages/cloudflare/src/migrations/"*.sql; do
    sqlite3 "$ADOPT_TEST_OLD" < "$migration"
  done
  sqlite3 "$ADOPT_TEST_CONTROL" <<SQL
INSERT INTO users(did,handle,state,created_at,updated_at,last_seen_at)
VALUES('$operator_did','noz.am','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO workspaces(id,owner_did,name,state,plan,created_at,updated_at,last_seen_at)
VALUES('$workspace_id','$operator_did','Operator workspace','active','free','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO memberships(workspace_id,did,role,created_at)
VALUES('$workspace_id','$operator_did','owner','2026-01-01T00:00:00.000Z');
INSERT INTO tenant_slots(binding_name,workspace_id,database_id,schema_version,status)
VALUES('TENANT_DB_000','$workspace_id','$old_database_id',13,'assigned');
SQL
  sqlite3 "$ADOPT_TEST_OLD" "INSERT INTO workspace_metadata(id,workspace_id,database_id,plan) VALUES(1,'$workspace_id','$old_database_id','free');"
  sqlite3 "$ADOPT_TEST_MAIN" "CREATE TABLE retained_import(value TEXT); INSERT INTO retained_import VALUES('keep');"
  : > "$ADOPT_TEST_CALLS"
}

pnpm() {
  local binding="" sql="" previous="" argument database rows
  printf '%s\n' "$*" >> "$ADOPT_TEST_CALLS"
  for argument in "$@"; do
    [[ "$previous" != execute ]] || binding="$argument"
    [[ "$previous" != --command ]] || sql="$argument"
    previous="$argument"
  done
  case "$binding" in
    CONTROL_DB) database="$ADOPT_TEST_CONTROL" ;;
    TENANT_DB_000) database="$ADOPT_TEST_OLD" ;;
    PRODUCTION_IMPORTED_DB) database="$ADOPT_TEST_MAIN" ;;
    *) printf 'unexpected D1 binding: %s\n' "$binding" >&2; return 1 ;;
  esac
  if [[ "$sql" == "UPDATE tenant_slots SET workspace_id=NULL,status='deleting'"* ]]; then
    case "${ADOPT_TEST_FAULT:-}" in
      expired) sqlite3 "$ADOPT_TEST_CONTROL" "UPDATE workspaces SET execution_lease_until='2000-01-01T00:00:00.000Z';" ;;
      stolen) sqlite3 "$ADOPT_TEST_CONTROL" "UPDATE workspaces SET execution_lease_token='other-run';" ;;
    esac
  elif [[ "$sql" == "UPDATE tenant_slots SET workspace_id='"* && "${ADOPT_TEST_FAULT:-}" == expired_after_quarantine ]]; then
    sqlite3 "$ADOPT_TEST_CONTROL" "UPDATE workspaces SET execution_lease_until='2000-01-01T00:00:00.000Z';"
  fi
  rows="$(sqlite3 -json "$database" "$sql")" || return 1
  if [[ "$sql" == "INSERT INTO production_workspace_identity"* && "${ADOPT_TEST_FAULT:-}" == late_content ]]; then
    sqlite3 "$ADOPT_TEST_OLD" "INSERT INTO status_pages(id,title,public_slug) VALUES('00000000-0000-4000-8000-000000000003','Keep','keep');"
  fi
  if [[ "$sql" == "UPDATE workspaces SET execution_lease_token='production-import-adoption:"* && -n "${ADOPT_TEST_FAULT:-}" ]]; then
    case "$ADOPT_TEST_FAULT" in
      content) sqlite3 "$ADOPT_TEST_OLD" "INSERT INTO status_pages(id,title,public_slug) VALUES('00000000-0000-4000-8000-000000000003','Keep','keep');" ;;
      identity) sqlite3 "$ADOPT_TEST_OLD" "UPDATE workspace_metadata SET database_id='00000000-0000-4000-8000-000000000099';" ;;
    esac
  fi
  printf '[{"success":true,"results":%s}]\n' "${rows:-[]}"
}
export -f pnpm

initialize_fixture
bash "$root/scripts/adopt-production-import.sh" --dry-run >/dev/null
[[ "$(sqlite3 "$ADOPT_TEST_MAIN" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='production_workspace_identity'")" == 0 ]]
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='TENANT_DB_000'")" == assigned ]]
if grep -Eq -- '--command (CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)' "$ADOPT_TEST_CALLS"; then
  printf '%s\n' 'dry-run performed an adoption write' >&2
  exit 1
fi

: > "$ADOPT_TEST_CALLS"
bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null
[[ "$(sqlite3 "$ADOPT_TEST_MAIN" 'SELECT workspace_id || ":" || database_id FROM production_workspace_identity WHERE id=1')" == "$workspace_id:$main_database_id" ]]
[[ "$(sqlite3 "$ADOPT_TEST_MAIN" 'SELECT value FROM retained_import')" == keep ]]
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT binding_name || ':' || database_id FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'")" == "PRODUCTION_IMPORTED_DB:$main_database_id" ]]
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status || ':' || coalesce(workspace_id,'') FROM tenant_slots WHERE binding_name='TENANT_DB_000'")" == deleting: ]]
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT role FROM memberships WHERE workspace_id='$workspace_id' AND did='$operator_did'")" == owner ]]
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT state || ':' || coalesce(execution_lease_token,'') FROM workspaces WHERE id='$workspace_id'")" == active: ]]

# Already-complete dry runs must not clear even a matching legacy adoption lease.
sqlite3 "$ADOPT_TEST_CONTROL" "UPDATE workspaces SET execution_lease_token='production-import-adoption:$workspace_id',execution_lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+16 minutes') WHERE id='$workspace_id';"
: > "$ADOPT_TEST_CALLS"
bash "$root/scripts/adopt-production-import.sh" >/dev/null
bash "$root/scripts/adopt-production-import.sh" --dry-run >/dev/null
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT execution_lease_token FROM workspaces WHERE id='$workspace_id'")" == "production-import-adoption:$workspace_id" ]]
if grep -Eq -- '--command (CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)' "$ADOPT_TEST_CALLS"; then
  printf '%s\n' 'already-complete dry-run performed a write' >&2
  exit 1
fi

# Simulate a process stop after quarantining the old tenant but before assigning
# the imported slot. A concurrent run cannot take over its live adoption lease.
sqlite3 "$ADOPT_TEST_CONTROL" "UPDATE tenant_slots SET workspace_id=NULL,status='deleting' WHERE binding_name='PRODUCTION_IMPORTED_DB';"
if bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null 2>&1; then
  printf '%s\n' 'live adoption lease was taken over' >&2
  exit 1
fi
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT execution_lease_token FROM workspaces WHERE id='$workspace_id'")" == "production-import-adoption:$workspace_id" ]]
: > "$ADOPT_TEST_CALLS"
bash "$root/scripts/adopt-production-import.sh" --dry-run >/dev/null
if grep -Eq -- '--command (CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)' "$ADOPT_TEST_CALLS"; then
  printf '%s\n' 'recovery dry-run performed a write' >&2
  exit 1
fi
# Once expired, the same marker and retained old identity allow recovery.
sqlite3 "$ADOPT_TEST_CONTROL" "UPDATE workspaces SET execution_lease_until='2000-01-01T00:00:00.000Z' WHERE id='$workspace_id';"
bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT binding_name FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'")" == PRODUCTION_IMPORTED_DB ]]
[[ "$(sqlite3 "$ADOPT_TEST_OLD" 'SELECT workspace_id || ":" || database_id FROM workspace_metadata WHERE id=1')" == "$workspace_id:$old_database_id" ]]

# A marker owned by a different identity is never overwritten.
sqlite3 "$ADOPT_TEST_MAIN" "UPDATE production_workspace_identity SET workspace_id='00000000-0000-4000-8000-000000000099';"
if bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null 2>&1; then
  printf '%s\n' 'mismatched production identity marker was accepted' >&2
  exit 1
fi
[[ "$(sqlite3 "$ADOPT_TEST_MAIN" 'SELECT workspace_id FROM production_workspace_identity WHERE id=1')" == 00000000-0000-4000-8000-000000000099 ]]

# A populated legacy tenant blocks adoption before the marker or assignment.
initialize_fixture
sqlite3 "$ADOPT_TEST_OLD" "INSERT INTO status_pages(id,title,public_slug) VALUES('00000000-0000-4000-8000-000000000003','Keep','keep');"
if bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null 2>&1; then
  printf '%s\n' 'populated old tenant was accepted' >&2
  exit 1
fi
[[ "$(sqlite3 "$ADOPT_TEST_MAIN" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='production_workspace_identity'")" == 0 ]]
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='TENANT_DB_000'")" == assigned ]]

# Changes between preflight and acquisition must be rejected under the lease.
for fault in content identity; do
  initialize_fixture
  export ADOPT_TEST_FAULT="$fault"
  if bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null 2>&1; then
    printf 'old tenant %s changed during acquisition but was accepted\n' "$fault" >&2
    exit 1
  fi
  [[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='TENANT_DB_000'")" == assigned ]]
  [[ "$(sqlite3 "$ADOPT_TEST_MAIN" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='production_workspace_identity'")" == 0 ]]
done

# Recheck emptiness immediately before the transfer as well.
initialize_fixture
export ADOPT_TEST_FAULT=late_content
if bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null 2>&1; then
  printf '%s\n' 'content appearing before transfer was accepted' >&2
  exit 1
fi
[[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='TENANT_DB_000'")" == assigned ]]

# The SQL fence must reject expiry or replacement after the last lease read.
for fault in expired stolen expired_after_quarantine; do
  initialize_fixture
  export ADOPT_TEST_FAULT="$fault"
  if bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null 2>&1; then
    printf 'transfer accepted a %s lease\n' "$fault" >&2
    exit 1
  fi
  [[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='PRODUCTION_IMPORTED_DB'")" == deleting ]]
  if [[ "$fault" == expired_after_quarantine ]]; then
    [[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='TENANT_DB_000'")" == deleting ]]
    unset ADOPT_TEST_FAULT
    bash "$root/scripts/adopt-production-import.sh" --apply >/dev/null
    [[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT binding_name FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'")" == PRODUCTION_IMPORTED_DB ]]
  else
    [[ "$(sqlite3 "$ADOPT_TEST_CONTROL" "SELECT status FROM tenant_slots WHERE binding_name='TENANT_DB_000'")" == assigned ]]
  fi
  if [[ "$fault" == stolen ]]; then
    [[ "$(sqlite3 "$ADOPT_TEST_CONTROL" 'SELECT execution_lease_token FROM workspaces')" == other-run ]]
  fi
done

printf '%s\n' 'adopt-production-import tests passed'
