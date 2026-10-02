#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/deployment-target.sh"
environment_arg="${DEPLOY_ENVIRONMENT:-}"
dry_run=0
while (($#)); do
  case "$1" in
    --environment) environment_arg="${2:?environment required}"; shift 2 ;;
    --environment=*) environment_arg="${1#*=}"; shift ;;
    --dry-run) dry_run=1; shift ;;
    *) printf 'bootstrap-operator: unknown argument %s\n' "$1" >&2; exit 1 ;;
  esac
done
select_deployment_environment "$repo_root" "$environment_arg"
api_config="$repo_root/deploy/cloudflare/hosted/api.wrangler.toml"
if [[ "$deployment_environment" == staging ]]; then
  api_config="$repo_root/deploy/cloudflare/staging/oauth-api/wrangler.toml"
fi
operator_did="did:plc:lmkzmvv6sdxntwtyxpg7fqqq"
if ((dry_run)); then
  printf 'bootstrap-operator: would provision @noz.am in %s, preserving any existing workspace\n' "$deployment_environment"
  exit 0
fi
control() {
  pnpm --filter @uptime/api-worker exec wrangler d1 execute CONTROL_DB \
    --remote --json --config "$api_config" --command "$1"
}
tenant() {
  pnpm --filter @uptime/api-worker exec wrangler d1 execute "$binding_name" \
    --remote --json --config "$api_config" --command "$1"
}
uuid_pattern='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
user_state="$(control "SELECT state FROM users WHERE did='$operator_did'" | jq -r '.[0].results[0].state // "active"')"
[[ "$user_state" == active ]] || { printf 'bootstrap-operator: existing operator account is not active\n' >&2; exit 1; }
candidate_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
control "INSERT INTO users(did,handle,state,created_at,updated_at,last_seen_at)
VALUES('$operator_did','noz.am','active',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(did) DO NOTHING;
INSERT INTO workspaces(id,owner_did,name,state,plan,created_at,updated_at,last_seen_at,next_dispatch_at)
VALUES('$candidate_id','$operator_did','Operator test workspace','waiting_for_capacity','free',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(owner_did) DO NOTHING" >/dev/null
workspace="$(control "SELECT id,state FROM workspaces WHERE owner_did='$operator_did'" | jq -c '.[0].results[0]')"
workspace_id="$(jq -r '.id' <<< "$workspace")"
workspace_state="$(jq -r '.state' <<< "$workspace")"
[[ "$workspace_id" =~ $uuid_pattern ]] || { printf 'bootstrap-operator: invalid workspace identity\n' >&2; exit 1; }
case "$workspace_state" in
  active|suspended|waiting_for_capacity) ;;
  *) printf 'bootstrap-operator: refusing to resurrect a deleted workspace\n' >&2; exit 1 ;;
esac
slot="$(control "SELECT binding_name,database_id FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'" | jq -c '.[0].results[0] // empty')"
if [[ -z "$slot" ]]; then
  if [[ "$workspace_state" != waiting_for_capacity ]]; then
    printf 'bootstrap-operator: provisioned workspace has no assigned slot\n' >&2
    exit 1
  fi
  if [[ "$deployment_environment" == staging ]]; then
    slot="$(control "SELECT binding_name,database_id FROM tenant_slots WHERE binding_name='STAGING_OPERATOR_DB' AND status='available' AND workspace_id IS NULL" | jq -c '.[0].results[0] // empty')"
  else
    slot="$(control "SELECT s.binding_name,s.database_id FROM tenant_slots s WHERE s.status='available' AND s.workspace_id IS NULL AND NOT EXISTS(SELECT 1 FROM tenant_slot_controls c WHERE c.binding_name=s.binding_name AND c.admission_enabled=0) AND (SELECT count(*) FROM tenant_slots a WHERE a.status='available' AND a.workspace_id IS NULL AND NOT EXISTS(SELECT 1 FROM tenant_slot_controls c WHERE c.binding_name=a.binding_name AND c.admission_enabled=0)) > 1 ORDER BY s.binding_name LIMIT 1" | jq -c '.[0].results[0] // empty')"
  fi
fi
[[ -n "$slot" ]] || { printf 'bootstrap-operator: no ready operator database is available\n' >&2; exit 1; }
binding_name="$(jq -r '.binding_name' <<< "$slot")"
database_id="$(jq -r '.database_id' <<< "$slot")"
[[ "$binding_name" =~ ^[A-Z][A-Z0-9_]{0,63}$ && "$database_id" =~ $uuid_pattern ]] || { printf 'bootstrap-operator: invalid slot identity\n' >&2; exit 1; }
control "UPDATE tenant_slots SET workspace_id='$workspace_id',status='assigned' WHERE binding_name='$binding_name' AND database_id='$database_id' AND ((status='available' AND workspace_id IS NULL) OR (status='assigned' AND workspace_id='$workspace_id')) AND NOT EXISTS(SELECT 1 FROM tenant_slots WHERE workspace_id='$workspace_id' AND binding_name<>'$binding_name'); INSERT INTO memberships(workspace_id,did,role,created_at) VALUES('$workspace_id','$operator_did','owner',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(workspace_id,did) DO NOTHING" >/dev/null
assigned="$(control "SELECT binding_name FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'" | jq -r '.[0].results[0].binding_name // empty')"
[[ "$assigned" == "$binding_name" ]] || { printf 'bootstrap-operator: operator slot claim failed\n' >&2; exit 1; }
# Match the runtime allocator: identity is written only into an empty database.
tenant "INSERT INTO workspace_metadata(id,workspace_id,database_id,plan,routing_generation) SELECT 1,'$workspace_id','$database_id','free',1 WHERE NOT EXISTS(SELECT 1 FROM workspace_metadata) AND (SELECT count(*) FROM monitors)+(SELECT count(*) FROM notification_services)+(SELECT count(*) FROM status_pages)=0" >/dev/null
identity="$(tenant "SELECT workspace_id,database_id FROM workspace_metadata WHERE id=1" | jq -c '.[0].results[0]')"
[[ "$(jq -r '.workspace_id' <<< "$identity")" == "$workspace_id" && "$(jq -r '.database_id' <<< "$identity")" == "$database_id" ]] || { printf 'bootstrap-operator: tenant identity mismatch, workspace remains unavailable\n' >&2; exit 1; }
control "UPDATE workspaces SET state='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='$workspace_id' AND state='waiting_for_capacity'" >/dev/null
printf 'bootstrap-operator: @noz.am workspace %s uses %s (%s)\n' "$workspace_id" "$binding_name" "$workspace_state"
