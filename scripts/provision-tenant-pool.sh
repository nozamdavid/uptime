#!/usr/bin/env bash
# Idempotently provision the hosted tenant D1 pool (production only; staging runs on PostgreSQL on the VPS).
set -euo pipefail
sql_quote() { local value="$1"; value="$(printf '%s' "$value" | sed "s/'/''/g")"; printf "'%s'" "$value"; }
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/deployment-target.sh"

environment_arg="${DEPLOY_ENVIRONMENT:-}"
capacity_arg=""
capacity_explicit=0
dry_run=0
usage() {
  cat <<'EOF'
Usage: scripts/provision-tenant-pool.sh [options]
  --environment production (staging D1 is retired)
  --capacity 1..10
  --dry-run
EOF
}
while (($#)); do
  case "$1" in
    --environment) (($# >= 2)) || { printf '%s\n' 'provision-tenant-pool: --environment requires a value' >&2; exit 1; }; environment_arg="$2"; shift 2 ;;
    --environment=*) environment_arg="${1#*=}"; shift ;;
    --capacity) (($# >= 2)) || { printf '%s\n' 'provision-tenant-pool: --capacity requires a value' >&2; exit 1; }; capacity_arg="$2"; capacity_explicit=1; shift 2 ;;
    --capacity=*) capacity_arg="${1#*=}"; capacity_explicit=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf '%s\n' "provision-tenant-pool: unknown argument: $1" >&2; exit 1 ;;
  esac
done
select_deployment_environment "$repo_root" "$environment_arg"
case "$capacity_arg" in
  "") ;;
  *[!0-9]*) printf '%s\n' 'provision-tenant-pool: capacity must be an integer from 1 to 10' >&2; exit 1 ;;
  *) [[ "$capacity_arg" =~ ^([1-9]|10)$ ]] || { printf '%s\n' 'provision-tenant-pool: capacity must be an integer from 1 to 10' >&2; exit 1; } ;;
esac

if [[ "$deployment_environment" == staging ]]; then
  printf '%s\n' 'provision-tenant-pool: staging D1 is retired; staging uses PostgreSQL on the VPS (see scripts/postgres-staging-bootstrap.ts)' >&2
  exit 1
fi

control_config="$repo_root/deploy/cloudflare/hosted/api.wrangler.toml"
worker_config="$repo_root/deploy/cloudflare/hosted/coordinator.wrangler.toml"
control_db=uptime-control
prefix=uptime-tenant
tenant_migrations_dir=../../../packages/cloudflare/src/migrations
[[ -f "$control_config" && -f "$worker_config" ]] || { printf '%s\n' 'provision-tenant-pool: required Wrangler config is missing' >&2; exit 1; }

if [[ "$deployment_environment" == production ]]; then
  for config in "$control_config" "$worker_config"; do
    awk '
      /^\[\[d1_databases\]\]/{in_binding=0}
      /^binding = "CONTROL_DB"$/{in_binding=1}
      in_binding && /^database_name = "uptime-control"$/{has_name=1}
      in_binding && /^database_id = "261093f4-98e2-48c8-b84d-932b7f27af7f"$/{has_id=1}
      END{exit(!(has_name && has_id))}
    ' "$config" || { printf 'provision-tenant-pool: production CONTROL_DB binding is missing or mismatched in %s\n' "$config" >&2; exit 1; }
    awk '
      /^\[\[d1_databases\]\]/{in_binding=0}
      /^binding = "PRODUCTION_IMPORTED_DB"$/{in_binding=1}
      in_binding && /^database_name = "uptime"$/{has_name=1}
      in_binding && /^database_id = "17c009df-5b56-44cc-9776-73e0f1775b0f"$/{has_id=1}
      in_binding && /^migrations_dir =/{has_migrations=1}
      END{exit(!(has_name && has_id && !has_migrations))}
    ' "$config" || { printf 'provision-tenant-pool: production import binding is missing, mismatched, or migration-enabled in %s\n' "$config" >&2; exit 1; }
  done
fi

wrangler() { pnpm --filter @uptime/api-worker exec wrangler "$@"; }
json_first() { jq -r "$1" 2>/dev/null | head -n 1 || true; }
database_id_for() { printf '%s' "$inventory" | jq -r --arg n "$1" '.. | objects | select(.name? == $n) | (.uuid // .database_id) // empty' 2>/dev/null | head -n 1; }
if ((!dry_run)); then
  wrangler d1 migrations apply "$control_db" --remote --config "$control_config" >/dev/null
fi
if [[ -z "$capacity_arg" ]]; then
  if ((dry_run)); then
    capacity_arg="${PROVISION_TEST_CAPACITY:-10}"
    printf '%s\n' "provision-tenant-pool: dry-run would read max_workspaces (planning with $capacity_arg)" >&2
  else
    control_json="$(wrangler d1 execute "$control_db" --remote --config "$control_config" --command 'SELECT max_workspaces FROM service_controls WHERE id=1' --json)"
    capacity_arg="$(printf '%s' "$control_json" | json_first '.. | objects | .max_workspaces? // empty')"
    [[ "$capacity_arg" =~ ^[1-9][0-9]*$ && "$capacity_arg" -le 10 ]] || { printf '%s\n' 'provision-tenant-pool: invalid service_controls.max_workspaces' >&2; exit 1; }
  fi
fi

bindings=()
names=()
for ((slot=0; slot<capacity_arg; slot++)); do
  bindings+=("TENANT_DB_$(printf '%03d' "$slot")")
  names+=("$prefix-$(printf '%03d' "$slot")")
done
printf '%s\n' "provision-tenant-pool: environment=$deployment_environment capacity=$capacity_arg databases=${#bindings[@]}" >&2
if ((dry_run)); then
  printf '%s\n' 'provision-tenant-pool: dry-run, no Cloudflare or config writes' >&2
  exit 0
fi

if ((capacity_explicit)); then
  wrangler d1 execute "$control_db" --remote --config "$control_config" --command "UPDATE service_controls SET max_workspaces=$(sql_quote "$capacity_arg") WHERE id=1" >/dev/null
fi
inventory="$(wrangler d1 list --json --config "$control_config")"

for i in "${!bindings[@]}"; do
  binding="${bindings[$i]}"; db_name="${names[$i]}"; database_id="$(database_id_for "$db_name")"
  if [[ -z "$database_id" ]]; then
    wrangler d1 create "$db_name" --update-config=false --config "$control_config" >/dev/null
    inventory="$(wrangler d1 list --json --config "$control_config")"
    database_id="$(database_id_for "$db_name")"
    [[ "$database_id" =~ ^[0-9a-fA-F-]{36}$ ]] || { printf '%s\n' "provision-tenant-pool: unable to resolve ID for $db_name" >&2; exit 1; }
  fi
  [[ "$database_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || { printf 'provision-tenant-pool: invalid database ID\n' >&2; exit 1; }
  if [[ "$deployment_environment" == production && "$database_id" == 17c009df-5b56-44cc-9776-73e0f1775b0f ]]; then
    printf '%s\n' 'provision-tenant-pool: refusing to include the production import in the tenant pool' >&2
    exit 1
  fi
  for config in "$control_config" "$worker_config"; do
    if grep -q "binding = \"$binding\"" "$config"; then
      awk -v b="$binding" -v n="$db_name" -v id="$database_id" '
        /^\[\[d1_databases\]\]/{if(found) exit(ok ? 0 : 1); found=0; ok=0}
        /^binding = /{if($0 == "binding = \"" b "\"") found=1}
        found && /^database_name = /{if($0 == "database_name = \"" n "\"") ok++}
        found && /^database_id = /{if($0 == "database_id = \"" id "\"") ok++}
        END{exit(ok == 2 ? 0 : 1)}
      ' "$config" || { printf '%s\n' "provision-tenant-pool: binding $binding does not match expected database" >&2; exit 1; }
    else
      printf '\n[[d1_databases]]\nbinding = "%s"\ndatabase_name = "%s"\ndatabase_id = "%s"\nmigrations_dir = "%s"\n' "$binding" "$db_name" "$database_id" "$tenant_migrations_dir" >> "$config"
    fi
  done
  slot_json="$(wrangler d1 execute "$control_db" --remote --config "$control_config" --command "SELECT binding_name,database_id,status FROM tenant_slots WHERE binding_name=$(sql_quote "$binding")" --json)"
  existing_id="$(printf '%s' "$slot_json" | json_first '.. | objects | .database_id? // empty')"
  existing_status="$(printf '%s' "$slot_json" | json_first '.. | objects | .status? // empty')"
  if [[ -n "$existing_id" ]]; then
    [[ "$existing_id" == "$database_id" ]] || { printf '%s\n' "provision-tenant-pool: slot $binding ID mismatch" >&2; exit 1; }
  else
    existing_status=""
  fi
  if [[ "$deployment_environment" == production && "$existing_status" == deleting ]]; then
    printf '%s\n' "provision-tenant-pool: preserving quarantined $binding without tenant migrations" >&2
  else
    wrangler d1 migrations apply "$db_name" --remote --config "$worker_config" >/dev/null
  fi
  if [[ -z "$existing_id" ]]; then
    used_json="$(wrangler d1 execute "$db_name" --remote --config "$worker_config" --command 'SELECT (SELECT count(*) FROM workspace_metadata) + (SELECT count(*) FROM monitors) + (SELECT count(*) FROM notification_services) + (SELECT count(*) FROM status_pages) AS used' --json)"
    used="$(printf '%s' "$used_json" | json_first '.. | objects | .used? // empty')"
    [[ "$used" =~ ^[0-9]+$ ]] || { printf '%s\n' "provision-tenant-pool: could not verify $db_name is empty" >&2; exit 1; }
    ((used == 0)) || { printf '%s\n' "provision-tenant-pool: refusing to register non-empty database $db_name" >&2; exit 1; }
    sql="INSERT INTO tenant_slots(binding_name,database_id,schema_version,status) VALUES($(sql_quote "$binding"),$(sql_quote "$database_id"),13,'available'); INSERT INTO tenant_slot_controls(binding_name,admission_enabled) VALUES($(sql_quote "$binding"),1);"
    wrangler d1 execute "$control_db" --remote --config "$control_config" --command "$sql" >/dev/null
  fi
done

printf '%s\n' 'provision-tenant-pool: complete' >&2
