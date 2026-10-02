#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export REGISTER_TEST_CONTROL="$scratch/control.sqlite"
export REGISTER_TEST_IMPORTED="$scratch/imported.sqlite"
export REGISTER_TEST_CALLS="$scratch/calls"

for migration in "$root/packages/cloudflare/src/control-migrations/"*.sql; do
  sqlite3 "$REGISTER_TEST_CONTROL" < "$migration"
done
for migration in "$root/packages/cloudflare/src/migrations/"*.sql; do
  sqlite3 "$REGISTER_TEST_IMPORTED" < "$migration"
done
sqlite3 "$REGISTER_TEST_IMPORTED" <<'SQL'
INSERT INTO monitors(
  id, name, url, interval_seconds, timeout_ms, next_check_at
) VALUES(
  '00000000-0000-4000-8000-000000000001', 'Imported monitor', 'https://example.test',
  300, 5000, '2026-01-01T00:00:00.000Z'
);
INSERT INTO status_pages(id, title, public_slug)
VALUES('00000000-0000-4000-8000-000000000002', 'Imported status', 'imported-status');
INSERT INTO monitor_daily_uptime(
  monitor_id, day, uptime_percentage, source, received_count, success_count
) VALUES(
  '00000000-0000-4000-8000-000000000001', '2026-01-01', 99.5, 'imported', 10, 10
);
SQL

git() {
  case "$*" in
    *symbolic-ref*) printf '%s\n' 'codex/product-release-plan' ;;
    *) command git "$@" ;;
  esac
}
pnpm() {
  local database="" sql="" previous="" argument rows
  printf '%s\n' "$*" >> "$REGISTER_TEST_CALLS"
  for argument in "$@"; do
    [[ "$previous" != execute ]] || database="$argument"
    [[ "$previous" != --command ]] || sql="$argument"
    previous="$argument"
  done
  case "$database" in
    CONTROL_DB) database="$REGISTER_TEST_CONTROL" ;;
    STAGING_IMPORTED_DB) database="$REGISTER_TEST_IMPORTED" ;;
    *) return 1 ;;
  esac
  rows="$(sqlite3 -json "$database" "$sql")" || return 1
  printf '[{"success":true,"results":%s}]\n' "${rows:-[]}"
}
export -f git pnpm

: > "$REGISTER_TEST_CALLS"
"$root/scripts/register-staging-import.sh" --environment staging --dry-run >/dev/null
[[ ! -s "$REGISTER_TEST_CALLS" ]]

: > "$REGISTER_TEST_CALLS"
if "$root/scripts/register-staging-import.sh" --environment production >/dev/null 2>&1; then
  printf '%s\n' 'production guard was ignored' >&2
  exit 1
fi
[[ ! -s "$REGISTER_TEST_CALLS" ]]

: > "$REGISTER_TEST_CALLS"
"$root/scripts/register-staging-import.sh" --environment staging >/dev/null
[[ "$(sqlite3 "$REGISTER_TEST_CONTROL" "SELECT database_id FROM tenant_slots WHERE binding_name='STAGING_IMPORTED_DB'")" == '3900c94a-82a0-4422-a5f8-1a56b781cea7' ]]
[[ "$(sqlite3 "$REGISTER_TEST_CONTROL" "SELECT admission_enabled FROM tenant_slot_controls WHERE binding_name='STAGING_IMPORTED_DB'")" == 0 ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT count(*) FROM workspace_metadata')" == 0 ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT count(*) FROM monitors')" == 1 ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT count(*) FROM status_pages')" == 1 ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT source FROM monitor_daily_uptime')" == imported ]]

sqlite3 "$REGISTER_TEST_CONTROL" <<'SQL'
UPDATE tenant_slots
SET workspace_id = '00000000-0000-4000-8000-000000000099', status = 'assigned'
WHERE binding_name = 'STAGING_IMPORTED_DB';
SQL
sqlite3 "$REGISTER_TEST_IMPORTED" "INSERT INTO staging_workspace_identity VALUES(1,'00000000-0000-4000-8000-000000000099','3900c94a-82a0-4422-a5f8-1a56b781cea7')"
"$root/scripts/register-staging-import.sh" --environment staging >/dev/null
[[ "$(sqlite3 "$REGISTER_TEST_CONTROL" "SELECT workspace_id || ':' || status FROM tenant_slots WHERE binding_name='STAGING_IMPORTED_DB'")" == '00000000-0000-4000-8000-000000000099:assigned' ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT workspace_id FROM staging_workspace_identity')" == '00000000-0000-4000-8000-000000000099' ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT count(*) FROM monitors')" == 1 ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT count(*) FROM status_pages')" == 1 ]]
[[ "$(sqlite3 "$REGISTER_TEST_IMPORTED" 'SELECT count(*) FROM monitor_daily_uptime')" == 1 ]]

wrong="$scratch/wrong"
mkdir -p "$wrong/scripts" "$wrong/deploy/cloudflare/staging/oauth-api" "$wrong/deploy/cloudflare/staging/hosted-coordinator"
cp "$root/scripts/register-staging-import.sh" "$wrong/scripts/"
cp "$root/scripts/deployment-target.sh" "$wrong/scripts/"
cp "$root/deploy/cloudflare/staging/oauth-api/wrangler.toml" "$wrong/deploy/cloudflare/staging/oauth-api/"
cp "$root/deploy/cloudflare/staging/hosted-coordinator/wrangler.toml" "$wrong/deploy/cloudflare/staging/hosted-coordinator/"
sed -i.bak 's/3900c94a-82a0-4422-a5f8-1a56b781cea7/00000000-0000-4000-8000-000000000099/g' "$wrong/deploy/cloudflare/staging/oauth-api/wrangler.toml"
rm -f "$wrong/deploy/cloudflare/staging/oauth-api/wrangler.toml.bak"
: > "$REGISTER_TEST_CALLS"
if "$wrong/scripts/register-staging-import.sh" --environment staging >/dev/null 2>&1; then
  printf '%s\n' 'binding identity mismatch was ignored' >&2
  exit 1
fi
[[ ! -s "$REGISTER_TEST_CALLS" ]]

printf '%s\n' 'register-staging-import tests passed'
