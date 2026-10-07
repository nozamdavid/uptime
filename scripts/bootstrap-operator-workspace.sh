#!/usr/bin/env bash
# Verify the @noz.am operator workspace in the production Cloudflare D1 control plane.
# Staging D1 is retired; staging uses PostgreSQL on the VPS (see scripts/postgres-staging-bootstrap.ts).
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
if [[ "$deployment_environment" == staging ]]; then
  printf '%s\n' 'bootstrap-operator: staging D1 is retired; staging uses PostgreSQL on the VPS (see scripts/postgres-staging-bootstrap.ts)' >&2
  exit 1
fi
api_config="$repo_root/deploy/cloudflare/hosted/api.wrangler.toml"
operator_did="did:plc:lmkzmvv6sdxntwtyxpg7fqqq"

awk '
  /^\[\[d1_databases\]\]/{in_binding=0}
  /^binding = "PRODUCTION_IMPORTED_DB"$/{in_binding=1}
  in_binding && /^database_name = "uptime"$/{has_name=1}
  in_binding && /^database_id = "17c009df-5b56-44cc-9776-73e0f1775b0f"$/{has_id=1}
  in_binding && /^migrations_dir =/{has_migrations=1}
  END{exit(!(has_name && has_id && !has_migrations))}
' "$api_config" || { printf 'bootstrap-operator: production import binding is missing, mismatched, or migration-enabled\n' >&2; exit 1; }

if ((dry_run)); then
  printf 'bootstrap-operator: would verify the existing @noz.am production import assignment\n'
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

workspace="$(control "SELECT id,state,owner_did FROM workspaces WHERE owner_did='$operator_did'" | jq -c '.[0].results[0] // empty')"
[[ -n "$workspace" ]] || { printf 'bootstrap-operator: production workspace is missing; run the production import adoption helper after signoff\n' >&2; exit 1; }
workspace_id="$(jq -r '.id' <<< "$workspace")"
workspace_state="$(jq -r '.state' <<< "$workspace")"
workspace_owner="$(jq -r '.owner_did' <<< "$workspace")"
[[ "$workspace_id" =~ $uuid_pattern && "$workspace_owner" == "$operator_did" && "$workspace_state" == active ]] || { printf 'bootstrap-operator: production operator workspace is not the expected active identity\n' >&2; exit 1; }
membership_role="$(control "SELECT role FROM memberships WHERE workspace_id='$workspace_id' AND did='$operator_did'" | jq -r '.[0].results[0].role // empty')"
[[ "$membership_role" == owner ]] || { printf 'bootstrap-operator: production owner membership is missing\n' >&2; exit 1; }
slot="$(control "SELECT binding_name,database_id FROM tenant_slots WHERE workspace_id='$workspace_id' AND status='assigned'" | jq -c '.[0].results[0] // empty')"
[[ -n "$slot" && "$(jq -r '.binding_name' <<< "$slot")" == PRODUCTION_IMPORTED_DB && "$(jq -r '.database_id' <<< "$slot")" == 17c009df-5b56-44cc-9776-73e0f1775b0f ]] || { printf 'bootstrap-operator: production import is not assigned to the existing operator workspace; no free slot was allocated\n' >&2; exit 1; }
binding_name=PRODUCTION_IMPORTED_DB
identity="$(tenant "SELECT id,workspace_id,database_id,(SELECT count(*) FROM production_workspace_identity) AS marker_count FROM production_workspace_identity WHERE id=1" | jq -c '.[0].results[0] // empty')"
[[ -n "$identity" && "$(jq -r '.id' <<< "$identity")" == 1 && "$(jq -r '.marker_count' <<< "$identity")" == 1 && "$(jq -r '.workspace_id' <<< "$identity")" == "$workspace_id" && "$(jq -r '.database_id' <<< "$identity")" == 17c009df-5b56-44cc-9776-73e0f1775b0f ]] || { printf 'bootstrap-operator: production import identity marker mismatch\n' >&2; exit 1; }
printf 'bootstrap-operator: @noz.am existing workspace %s uses PRODUCTION_IMPORTED_DB; no free workspace changes made\n' "$workspace_id"
