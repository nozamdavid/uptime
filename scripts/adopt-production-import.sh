#!/usr/bin/env bash
# Attach the existing production uptime database to @noz.am without migrating
# or rewriting its monitoring data. --apply is required for every remote write.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
api_config="$repo_root/deploy/cloudflare/hosted/api.wrangler.toml"
coordinator_config="$repo_root/deploy/cloudflare/hosted/coordinator.wrangler.toml"
operator_did="did:plc:lmkzmvv6sdxntwtyxpg7fqqq"
main_database_id="17c009df-5b56-44cc-9776-73e0f1775b0f"
control_database_id="261093f4-98e2-48c8-b84d-932b7f27af7f"
dry_run=1

usage() {
  cat <<'EOF'
Usage: scripts/adopt-production-import.sh [--dry-run | --apply]

The default is read-only. --apply is the explicit signoff gate for remote D1
writes. This production-only helper preserves the existing operator workspace,
adds its singleton import marker, then assigns the existing uptime database.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --apply) dry_run=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'adopt-production-import: unknown argument %s\n' "$1" >&2; exit 1 ;;
  esac
done

binding_matches() {
  local config="$1" binding="$2" database_name="$3" database_id="$4" forbid_migrations="${5:-0}"
  awk -v expected_binding="$binding" -v expected_name="$database_name" \
      -v expected_id="$database_id" -v forbid_migrations="$forbid_migrations" '
    /^\[\[d1_databases\]\]/{in_binding=0}
    /^binding = /{if($0 == "binding = \"" expected_binding "\"") in_binding=1}
    in_binding && /^database_name = /{if($0 == "database_name = \"" expected_name "\"") has_name=1}
    in_binding && /^database_id = /{if($0 == "database_id = \"" expected_id "\"") has_id=1}
    in_binding && /^migrations_dir =/{has_migrations=1}
    END{exit(!(has_name && has_id && (!forbid_migrations || !has_migrations)))}
  ' "$config"
}

[[ -f "$api_config" && -f "$coordinator_config" ]] || { printf '%s\n' 'adopt-production-import: production hosted configs are missing' >&2; exit 1; }
binding_matches "$api_config" CONTROL_DB uptime-control "$control_database_id" || { printf '%s\n' 'adopt-production-import: hosted API CONTROL_DB identity mismatch' >&2; exit 1; }
binding_matches "$api_config" PRODUCTION_IMPORTED_DB uptime "$main_database_id" 1 || { printf '%s\n' 'adopt-production-import: hosted API import binding is missing, mismatched, or migration-enabled' >&2; exit 1; }
binding_matches "$coordinator_config" CONTROL_DB uptime-control "$control_database_id" || { printf '%s\n' 'adopt-production-import: hosted coordinator CONTROL_DB identity mismatch' >&2; exit 1; }
binding_matches "$coordinator_config" PRODUCTION_IMPORTED_DB uptime "$main_database_id" 1 || { printf '%s\n' 'adopt-production-import: hosted coordinator import binding is missing, mismatched, or migration-enabled' >&2; exit 1; }

wrangler() { pnpm --filter @uptime/api-worker exec wrangler "$@"; }
control() {
  wrangler d1 execute CONTROL_DB --remote --json --config "$api_config" --command "$1"
}
database() {
  local binding="$1" sql="$2"
  wrangler d1 execute "$binding" --remote --json --config "$api_config" --command "$sql"
}
sql_quote() {
  local value="$1"
  value="$(printf '%s' "$value" | sed "s/'/''/g")"
  printf "'%s'" "$value"
}
uuid_pattern='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'

workspace="$(control "SELECT id,state,owner_did FROM workspaces WHERE owner_did='$operator_did'")"
workspace_rows="$(printf '%s' "$workspace" | jq -er '.[0].results | length')"
[[ "$workspace_rows" == 1 ]] || { printf '%s\n' 'adopt-production-import: expected exactly one existing @noz.am workspace' >&2; exit 1; }
workspace_row="$(printf '%s' "$workspace" | jq -c '.[0].results[0]')"
workspace_id="$(jq -r '.id' <<< "$workspace_row")"
workspace_state="$(jq -r '.state' <<< "$workspace_row")"
workspace_owner="$(jq -r '.owner_did' <<< "$workspace_row")"
[[ "$workspace_id" =~ $uuid_pattern && "$workspace_state" == active && "$workspace_owner" == "$operator_did" ]] || { printf '%s\n' 'adopt-production-import: existing operator workspace must be active and retain the expected owner DID' >&2; exit 1; }

user_state="$(control "SELECT state FROM users WHERE did='$operator_did'" | jq -r '.[0].results[0].state // empty')"
membership_role="$(control "SELECT role FROM memberships WHERE workspace_id='$workspace_id' AND did='$operator_did'" | jq -r '.[0].results[0].role // empty')"
[[ "$user_state" == active && "$membership_role" == owner ]] || { printf '%s\n' 'adopt-production-import: existing active user and owner membership are required' >&2; exit 1; }

production_slot_json="$(control "SELECT binding_name,database_id,workspace_id,status FROM tenant_slots WHERE binding_name='PRODUCTION_IMPORTED_DB'")"
production_slot_count="$(printf '%s' "$production_slot_json" | jq -er '.[0].results | length')"
if ((production_slot_count > 1)); then
  printf '%s\n' 'adopt-production-import: duplicate production import slot rows' >&2
  exit 1
fi
production_slot="$(printf '%s' "$production_slot_json" | jq -c '.[0].results[0] // empty')"
if [[ -n "$production_slot" ]]; then
  [[ "$(jq -r '.database_id' <<< "$production_slot")" == "$main_database_id" ]] || { printf '%s\n' 'adopt-production-import: production slot database ID mismatch' >&2; exit 1; }
  production_slot_state="$(jq -r '.status' <<< "$production_slot")"
  production_slot_owner="$(jq -r '.workspace_id // empty' <<< "$production_slot")"
  case "$production_slot_state:$production_slot_owner" in
    assigned:"$workspace_id"|available:|deleting:) ;;
    *) printf '%s\n' 'adopt-production-import: production import is already assigned or quarantined elsewhere' >&2; exit 1 ;;
  esac
else
  production_slot_state="absent"
fi

assigned_json="$(control "SELECT binding_name,database_id,workspace_id,status FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'")"
assigned_count="$(printf '%s' "$assigned_json" | jq -er '.[0].results | length')"
((assigned_count <= 1)) || { printf '%s\n' 'adopt-production-import: workspace has multiple assigned slots' >&2; exit 1; }
current_slot="$(printf '%s' "$assigned_json" | jq -c '.[0].results[0] // empty')"
if [[ -n "$current_slot" && "$(jq -r '.binding_name' <<< "$current_slot")" == PRODUCTION_IMPORTED_DB ]]; then
  [[ "$(jq -r '.database_id' <<< "$current_slot")" == "$main_database_id" ]] || { printf '%s\n' 'adopt-production-import: assigned production import database ID mismatch' >&2; exit 1; }
  marker_state="$(database PRODUCTION_IMPORTED_DB "SELECT count(*) AS table_count FROM sqlite_master WHERE type='table' AND name='production_workspace_identity'" | jq -r '.[0].results[0].table_count // 0')"
  [[ "$marker_state" == 1 ]] || { printf '%s\n' 'adopt-production-import: assigned production database has no identity table' >&2; exit 1; }
  identity="$(database PRODUCTION_IMPORTED_DB 'SELECT id,workspace_id,database_id,(SELECT count(*) FROM production_workspace_identity) AS marker_count FROM production_workspace_identity WHERE id=1' | jq -c '.[0].results[0] // empty')"
  [[ -n "$identity" && "$(jq -r '.id' <<< "$identity")" == 1 && "$(jq -r '.marker_count' <<< "$identity")" == 1 && "$(jq -r '.workspace_id' <<< "$identity")" == "$workspace_id" && "$(jq -r '.database_id' <<< "$identity")" == "$main_database_id" ]] || { printf '%s\n' 'adopt-production-import: assigned production import identity marker mismatch' >&2; exit 1; }
  printf 'adopt-production-import: already complete for workspace %s; owner and imported identity verified\n' "$workspace_id"
  exit 0
fi

old_binding=""
old_database_id=""
old_quarantined=0
if [[ -n "$current_slot" ]]; then
  old_binding="$(jq -r '.binding_name' <<< "$current_slot")"
  old_database_id="$(jq -r '.database_id' <<< "$current_slot")"
  [[ "$old_binding" =~ ^TENANT_DB_00[0-9]$ && "$old_database_id" =~ $uuid_pattern ]] || { printf '%s\n' 'adopt-production-import: current slot is not one of the expected production tenant slots' >&2; exit 1; }
else
  # Resume a prior fail-closed run that quarantined the empty slot before the
  # control plane attached the production database.
  quarantined_json="$(control "SELECT binding_name,database_id FROM tenant_slots WHERE status='deleting' AND workspace_id IS NULL AND binding_name GLOB 'TENANT_DB_00[0-9]'")"
  while IFS='|' read -r candidate_binding candidate_database; do
    [[ -n "$candidate_binding" ]] || continue
    table_exists="$(database "$candidate_binding" "SELECT count(*) AS table_count FROM sqlite_master WHERE type='table' AND name='workspace_metadata'" | jq -r '.[0].results[0].table_count // 0')"
    [[ "$table_exists" == 1 ]] || continue
    metadata="$(database "$candidate_binding" 'SELECT workspace_id,database_id,plan FROM workspace_metadata WHERE id=1' | jq -c '.[0].results[0] // empty')"
    if [[ -n "$metadata" && "$(jq -r '.workspace_id' <<< "$metadata")" == "$workspace_id" && "$(jq -r '.database_id // empty' <<< "$metadata")" == "$candidate_database" ]]; then
      [[ -z "$old_binding" ]] || { printf '%s\n' 'adopt-production-import: multiple quarantined tenant identities match the operator workspace' >&2; exit 1; }
      old_binding="$candidate_binding"
      old_database_id="$candidate_database"
      old_quarantined=1
    fi
  done < <(printf '%s' "$quarantined_json" | jq -r '.[0].results[]? | [.binding_name,.database_id] | join("|")')
  [[ -n "$old_binding" ]] || { printf '%s\n' 'adopt-production-import: no assigned or recoverable old tenant slot matches the operator workspace' >&2; exit 1; }
fi

validate_old_tenant() {
  local old_metadata old_content
  old_metadata="$(database "$old_binding" 'SELECT workspace_id,database_id,plan FROM workspace_metadata WHERE id=1' | jq -c '.[0].results[0] // empty')"
  [[ -n "$old_metadata" && "$(jq -r '.workspace_id' <<< "$old_metadata")" == "$workspace_id" && "$(jq -r '.database_id // empty' <<< "$old_metadata")" == "$old_database_id" && "$(jq -r '.plan' <<< "$old_metadata")" == free ]] || { printf '%s\n' 'adopt-production-import: old tenant identity does not match the existing control slot' >&2; exit 1; }
  old_content="$(database "$old_binding" 'SELECT (SELECT EXISTS(SELECT 1 FROM monitors LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM status_pages LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM notification_services LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM badges LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM monitor_regions LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM check_runs LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM observations LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM network_diagnostics LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM notification_deliveries LIMIT 1)) + (SELECT EXISTS(SELECT 1 FROM monitor_daily_uptime LIMIT 1)) AS has_content' | jq -r '.[0].results[0].has_content')"
  [[ "$old_content" == 0 ]] || { printf '%s\n' 'adopt-production-import: old tenant contains monitoring or history rows and must remain assigned' >&2; exit 1; }
}
validate_old_tenant

marker_table_count="$(database PRODUCTION_IMPORTED_DB "SELECT count(*) AS table_count FROM sqlite_master WHERE type='table' AND name='production_workspace_identity'" | jq -r '.[0].results[0].table_count // 0')"
if [[ "$marker_table_count" == 1 ]]; then
  marker_count="$(database PRODUCTION_IMPORTED_DB 'SELECT count(*) AS marker_count FROM production_workspace_identity' | jq -r '.[0].results[0].marker_count')"
  if [[ "$marker_count" != 0 ]]; then
    identity="$(database PRODUCTION_IMPORTED_DB 'SELECT id,workspace_id,database_id,(SELECT count(*) FROM production_workspace_identity) AS marker_count FROM production_workspace_identity WHERE id=1' | jq -c '.[0].results[0] // empty')"
    [[ -n "$identity" && "$(jq -r '.id' <<< "$identity")" == 1 && "$(jq -r '.marker_count' <<< "$identity")" == 1 && "$(jq -r '.workspace_id' <<< "$identity")" == "$workspace_id" && "$(jq -r '.database_id' <<< "$identity")" == "$main_database_id" ]] || { printf '%s\n' 'adopt-production-import: refusing to overwrite an existing production identity marker' >&2; exit 1; }
  fi
elif [[ "$marker_table_count" != 0 ]]; then
  printf '%s\n' 'adopt-production-import: could not inspect production identity table state' >&2
  exit 1
fi

printf 'adopt-production-import: workspace=%s old_slot=%s old_db=%s imported_db=%s current=%s\n' \
  "$workspace_id" "$old_binding" "$old_database_id" "$main_database_id" \
  "$([[ "$old_quarantined" == 1 ]] && printf quarantined || printf assigned)"
if ((dry_run)); then
  printf '%s\n' 'adopt-production-import: dry-run complete; no remote writes performed'
  exit 0
fi

lease_token="production-import-adoption:$workspace_id:$(uuidgen | tr '[:upper:]' '[:lower:]')"
lease_guard="EXISTS(SELECT 1 FROM workspaces WHERE id='$workspace_id' AND owner_did='$operator_did' AND state='active' AND execution_lease_token='$lease_token' AND execution_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
lease_acquired=0
switch_started=0
completed=0
release_lease_if_safe() {
  if ((lease_acquired)) && { ((completed)) || ((!switch_started)); }; then
    control "UPDATE workspaces SET execution_lease_token=NULL,execution_lease_until=NULL WHERE id='$workspace_id' AND execution_lease_token='$lease_token'" >/dev/null 2>&1 || true
  fi
}
trap release_lease_if_safe EXIT

assert_lease() {
  local current_lease
  current_lease="$(control "SELECT execution_lease_token FROM workspaces WHERE id='$workspace_id' AND $lease_guard" | jq -r '.[0].results[0].execution_lease_token // empty')"
  [[ "$current_lease" == "$lease_token" ]] || { printf '%s\n' 'adopt-production-import: workspace execution lease is busy, expired, or lost; retry after the lease expires' >&2; exit 1; }
}
control "UPDATE workspaces SET execution_lease_token='$lease_token',execution_lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+16 minutes') WHERE id='$workspace_id' AND state='active' AND (execution_lease_until IS NULL OR execution_lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))" >/dev/null
assert_lease
lease_acquired=1
validate_old_tenant
assert_lease

# Reserve the import row as quarantined first so automatic allocation cannot
# claim it while the cross-database identity marker is being prepared.
if [[ "$production_slot_state" == absent ]]; then
  control "INSERT INTO tenant_slots(binding_name,database_id,schema_version,status) SELECT 'PRODUCTION_IMPORTED_DB','$main_database_id',12,'deleting' WHERE $lease_guard ON CONFLICT(binding_name) DO NOTHING" >/dev/null
fi
control "UPDATE tenant_slots SET status='deleting' WHERE binding_name='PRODUCTION_IMPORTED_DB' AND database_id='$main_database_id' AND status='available' AND workspace_id IS NULL AND $lease_guard" >/dev/null
reserved_slot="$(control "SELECT workspace_id,status FROM tenant_slots WHERE binding_name='PRODUCTION_IMPORTED_DB' AND database_id='$main_database_id'" | jq -c '.[0].results[0] // empty')"
[[ -n "$reserved_slot" && "$(jq -r '.status' <<< "$reserved_slot")" == deleting && -z "$(jq -r '.workspace_id // empty' <<< "$reserved_slot")" ]] || { printf '%s\n' 'adopt-production-import: could not reserve the production import slot' >&2; exit 1; }

# This marker is the only write to the imported uptime database.
assert_lease
database PRODUCTION_IMPORTED_DB 'CREATE TABLE IF NOT EXISTS production_workspace_identity(id INTEGER PRIMARY KEY CHECK(id=1),workspace_id TEXT NOT NULL,database_id TEXT NOT NULL)' >/dev/null
marker_count="$(database PRODUCTION_IMPORTED_DB 'SELECT count(*) AS marker_count FROM production_workspace_identity' | jq -r '.[0].results[0].marker_count')"
if [[ "$marker_count" == 0 ]]; then
  workspace_sql="$(sql_quote "$workspace_id")"
  database_sql="$(sql_quote "$main_database_id")"
  database PRODUCTION_IMPORTED_DB "INSERT INTO production_workspace_identity(id,workspace_id,database_id) SELECT 1,$workspace_sql,$database_sql WHERE NOT EXISTS(SELECT 1 FROM production_workspace_identity)" >/dev/null
fi
identity="$(database PRODUCTION_IMPORTED_DB 'SELECT id,workspace_id,database_id,(SELECT count(*) FROM production_workspace_identity) AS marker_count FROM production_workspace_identity WHERE id=1' | jq -c '.[0].results[0] // empty')"
[[ -n "$identity" && "$(jq -r '.id' <<< "$identity")" == 1 && "$(jq -r '.marker_count' <<< "$identity")" == 1 && "$(jq -r '.workspace_id' <<< "$identity")" == "$workspace_id" && "$(jq -r '.database_id' <<< "$identity")" == "$main_database_id" ]] || { printf '%s\n' 'adopt-production-import: imported identity marker verification failed; no existing marker was overwritten' >&2; exit 1; }

# Control-plane transition steps are individually retryable. If interrupted
# after quarantining the old slot, the marker and retained identity allow a
# new run to resume after the previous run's lease expires.
validate_old_tenant
assert_lease
switch_started=1
if [[ "$old_quarantined" != 1 ]]; then
  control "UPDATE tenant_slots SET workspace_id=NULL,status='deleting' WHERE binding_name='$old_binding' AND database_id='$old_database_id' AND workspace_id='$workspace_id' AND status='assigned' AND $lease_guard" >/dev/null
fi
control "UPDATE tenant_slots SET workspace_id='$workspace_id',status='assigned' WHERE binding_name='PRODUCTION_IMPORTED_DB' AND database_id='$main_database_id' AND status='deleting' AND workspace_id IS NULL AND $lease_guard AND NOT EXISTS(SELECT 1 FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned')" >/dev/null

assigned_json="$(control "SELECT binding_name,database_id FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'")"
assigned_count="$(printf '%s' "$assigned_json" | jq -er '.[0].results | length')"
assigned="$(printf '%s' "$assigned_json" | jq -c '.[0].results[0] // empty')"
old_slot="$(control "SELECT workspace_id,status FROM tenant_slots WHERE binding_name='$old_binding' AND database_id='$old_database_id'" | jq -c '.[0].results[0] // empty')"
[[ "$assigned_count" == 1 && -n "$assigned" && "$(jq -r '.binding_name' <<< "$assigned")" == PRODUCTION_IMPORTED_DB && "$(jq -r '.database_id' <<< "$assigned")" == "$main_database_id" && -n "$old_slot" && "$(jq -r '.status' <<< "$old_slot")" == deleting && -z "$(jq -r '.workspace_id // empty' <<< "$old_slot")" ]] || { printf '%s\n' 'adopt-production-import: control assignment verification failed; rerun after checking the retained lease and slot rows' >&2; exit 1; }

completed=1
printf 'adopt-production-import: adopted existing workspace %s; old slot %s remains quarantined with its identity and data intact\n' "$workspace_id" "$old_binding"
