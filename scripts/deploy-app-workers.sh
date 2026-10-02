#!/usr/bin/env bash
# Deploy the API and coordinator Workers (not the regional probe fleet).
#
# The probe fleet has its own generated configs and script:
#   scripts/deploy-workers.sh
#
# Usage:
#   scripts/deploy-app-workers.sh [--dry-run] [--secrets-file PATH] [--target api|coordinator|all]
#
# Secrets are uploaded with `--secrets-file`, which contains `KEY=value` lines.
# Never commit that file. Keys:
#   api:         SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD_HASH, CREDENTIAL_ENCRYPTION_SECRET
#   coordinator: PROBE_SIGNING_SECRET, CREDENTIAL_ENCRYPTION_SECRET
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/deployment-target.sh"
environment_arg="${DEPLOY_ENVIRONMENT:-}"
target="all"
dry_run=0
secrets_file=""

usage() {
  cat <<'EOF'
Usage: scripts/deploy-app-workers.sh [options]
  --environment staging|production  Deployment environment
  --target api|coordinator|all   Which Worker(s) to deploy (default: all)
  --secrets-file PATH            KEY=value secrets to upload alongside code
  --dry-run                      Validate bundles without deploying
  --help                         Show this message
EOF
}

while (($#)); do
  case "$1" in
    --environment) (($# >= 2)) || { echo "deploy-app-workers: --environment requires a value" >&2; exit 1; }; environment_arg="$2"; shift 2 ;;
    --environment=*) environment_arg="${1#*=}"; shift ;;
    --target) (($# >= 2)) || { echo "deploy-app-workers: --target requires a value" >&2; exit 1; }; target="$2"; shift 2 ;;
    --secrets-file) (($# >= 2)) || { echo "deploy-app-workers: --secrets-file requires a path" >&2; exit 1; }; secrets_file="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "deploy-app-workers: unknown argument: $1" >&2; exit 1 ;;
  esac
done

select_deployment_environment "$repo_root" "$environment_arg"
config_dir="$repo_root/deploy/cloudflare"
database_name="uptime"
if [[ "$deployment_environment" == "staging" ]]; then
  config_dir+="/staging"
  database_name="uptime-staging"
fi

case "$target" in
  api|coordinator|all) ;;
  *) echo "deploy-app-workers: --target must be api, coordinator, or all" >&2; exit 1 ;;
esac

if [[ -n "$secrets_file" ]]; then
  [[ -f "$secrets_file" ]] || { echo "deploy-app-workers: secrets file not found: $secrets_file" >&2; exit 1; }
fi

configs=()
if [[ "$target" == "api" || "$target" == "all" ]]; then
  configs+=("$config_dir/api/wrangler.toml")
fi

api_config="$config_dir/api/wrangler.toml"

# Both Workers query the same D1 database. Apply every pending migration once,
# before either Worker can begin executing newer SQL against the old schema.
if ((!dry_run)); then
  printf 'deploy-app-workers: applying D1 migrations before deployment\n' >&2
  pnpm --filter @uptime/api-worker exec wrangler d1 migrations apply "$database_name" \
    --remote --config "$api_config"
else
  printf 'deploy-app-workers: dry run, skipping remote D1 migrations\n' >&2
fi
if [[ "$target" == "coordinator" || "$target" == "all" ]]; then
  configs+=("$config_dir/coordinator/wrangler.toml")
fi

extra=()
if ((dry_run)); then
  extra+=(--dry-run)
fi
if [[ -n "$secrets_file" ]]; then
  extra+=(--secrets-file "$secrets_file")
fi

for config in "${configs[@]}"; do
  package_filter="@uptime/api-worker"
  if [[ "$config" == *"coordinator"* ]]; then
    package_filter="@uptime/coordinator-worker"
  fi
  printf 'deploy-app-workers: deploying %s (%s)\n' "$(basename -- "$(dirname -- "$config")")" "$config" >&2
  pnpm --filter "$package_filter" exec wrangler deploy --config "$config" ${extra[@]+"${extra[@]}"}
done

printf 'deploy-app-workers: deployed %d configuration(s)\n' "${#configs[@]}" >&2
