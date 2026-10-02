#!/usr/bin/env bash
# Adopt only the known staging import, without enabling free-plan SQL triggers.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/deployment-target.sh"
environment_arg="${DEPLOY_ENVIRONMENT:-}"
dry_run=0
while (($#)); do
  case "$1" in
    --environment) environment_arg="${2:?environment required}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) printf 'register-staging-import: unknown argument %s\n' "$1" >&2; exit 1 ;;
  esac
done
select_deployment_environment "$repo_root" "$environment_arg"
[[ "$deployment_environment" == staging ]] || { printf 'register-staging-import: staging only\n' >&2; exit 1; }
if ((dry_run)); then
  printf 'register-staging-import: would register the existing staging database as a held slot\n'
  exit 0
fi
api_config="$repo_root/deploy/cloudflare/staging/oauth-api/wrangler.toml"
coordinator_config="$repo_root/deploy/cloudflare/staging/hosted-coordinator/wrangler.toml"
database_id=3900c94a-82a0-4422-a5f8-1a56b781cea7
for config in "$api_config" "$coordinator_config"; do
  awk '
    /^\[\[d1_databases\]\]/{if(found) exit; found=0}
    /^binding = "STAGING_IMPORTED_DB"$/{found=1}
    found && /^database_name = "uptime-staging"$/{matched++}
    found && /^database_id = "3900c94a-82a0-4422-a5f8-1a56b781cea7"$/{matched++}
    END{exit(matched == 2 ? 0 : 1)}
  ' "$config" || { printf 'register-staging-import: imported binding identity mismatch\n' >&2; exit 1; }
done
control() { pnpm --filter @uptime/api-worker exec wrangler d1 execute CONTROL_DB --remote --json --config "$api_config" --command "$1"; }
imported() { pnpm --filter @uptime/api-worker exec wrangler d1 execute STAGING_IMPORTED_DB --remote --json --config "$api_config" --command "$1"; }
current="$(control "SELECT database_id FROM tenant_slots WHERE binding_name='STAGING_IMPORTED_DB'" | jq -r '.[0].results[0].database_id // empty')"
[[ -z "$current" || "$current" == "$database_id" ]] || { printf 'register-staging-import: registered database ID mismatch\n' >&2; exit 1; }
free_identity="$(imported 'SELECT count(*) AS n FROM workspace_metadata' | jq -r '.[0].results[0].n')"
[[ "$free_identity" == 0 ]] || { printf 'register-staging-import: refuses a database already governed by a free workspace\n' >&2; exit 1; }
imported "CREATE TABLE IF NOT EXISTS staging_workspace_identity(id INTEGER PRIMARY KEY CHECK(id=1),workspace_id TEXT NOT NULL,database_id TEXT NOT NULL)" >/dev/null
control "INSERT INTO tenant_slots(binding_name,database_id,schema_version,status) VALUES('STAGING_IMPORTED_DB','$database_id',13,'available') ON CONFLICT(binding_name) DO NOTHING;
INSERT INTO tenant_slot_controls(binding_name,admission_enabled) VALUES('STAGING_IMPORTED_DB',0) ON CONFLICT(binding_name) DO UPDATE SET admission_enabled=0" >/dev/null
printf 'register-staging-import: imported monitors/history registered, assignment and existing data preserved\n'
