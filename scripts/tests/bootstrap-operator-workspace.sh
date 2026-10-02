#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -r "$scratch"' EXIT
export BOOTSTRAP_TEST_CONTROL="$scratch/control.sqlite"
export BOOTSTRAP_TEST_TENANT="$scratch/tenant.sqlite"
export BOOTSTRAP_TEST_CALLS="$scratch/calls"
for migration in "$root/packages/cloudflare/src/control-migrations/"*.sql; do sqlite3 "$BOOTSTRAP_TEST_CONTROL" < "$migration"; done
for migration in "$root/packages/cloudflare/src/migrations/"*.sql; do sqlite3 "$BOOTSTRAP_TEST_TENANT" < "$migration"; done
sqlite3 "$BOOTSTRAP_TEST_CONTROL" "INSERT INTO tenant_slots(binding_name,database_id,schema_version,status) VALUES('STAGING_OPERATOR_DB','00000000-0000-4000-8000-000000000001',13,'available'); INSERT INTO tenant_slot_controls VALUES('STAGING_OPERATOR_DB',0)"
git() { printf '%s\n' 'codex/product-release-plan'; }
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
    CONTROL_DB) database="$BOOTSTRAP_TEST_CONTROL" ;;
    STAGING_OPERATOR_DB) database="$BOOTSTRAP_TEST_TENANT" ;;
    *) return 1 ;;
  esac
  rows="$(sqlite3 -json "$database" "$sql")" || return 1
  printf '[{"success":true,"results":%s}]\n' "${rows:-[]}"
}
export -f git uuidgen pnpm

"$root/scripts/bootstrap-operator-workspace.sh" --dry-run >/dev/null
[[ ! -f "$BOOTSTRAP_TEST_CALLS" ]]
if "$root/scripts/bootstrap-operator-workspace.sh" --environment production >/dev/null 2>&1; then exit 1; fi
[[ ! -f "$BOOTSTRAP_TEST_CALLS" ]]
"$root/scripts/bootstrap-operator-workspace.sh" >/dev/null
[[ "$(sqlite3 "$BOOTSTRAP_TEST_CONTROL" 'SELECT count(*) FROM workspaces WHERE state="active"')" == 1 ]]
[[ "$(sqlite3 "$BOOTSTRAP_TEST_TENANT" 'SELECT workspace_id FROM workspace_metadata')" == '00000000-0000-4000-8000-000000000002' ]]
# A rerun retains the tenant identity and its existing data.
sqlite3 "$BOOTSTRAP_TEST_TENANT" "INSERT INTO status_pages(id,title,public_slug) VALUES('00000000-0000-4000-8000-000000000003','Keep me','keep-me')"
"$root/scripts/bootstrap-operator-workspace.sh" >/dev/null
[[ "$(sqlite3 "$BOOTSTRAP_TEST_CONTROL" 'SELECT count(*) FROM workspaces')" == 1 ]]
[[ "$(sqlite3 "$BOOTSTRAP_TEST_TENANT" 'SELECT count(*) FROM status_pages')" == 1 ]]
# A mismatch never activates a waiting workspace.
sqlite3 "$BOOTSTRAP_TEST_CONTROL" "UPDATE workspaces SET state='waiting_for_capacity'"
sqlite3 "$BOOTSTRAP_TEST_TENANT" "UPDATE workspace_metadata SET workspace_id='00000000-0000-4000-8000-000000000099'"
if "$root/scripts/bootstrap-operator-workspace.sh" >/dev/null 2>&1; then exit 1; fi
[[ "$(sqlite3 "$BOOTSTRAP_TEST_CONTROL" 'SELECT state FROM workspaces')" == waiting_for_capacity ]]
printf 'bootstrap-operator-workspace tests passed\n'
