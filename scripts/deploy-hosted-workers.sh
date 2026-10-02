#!/usr/bin/env bash
# Provision the hosted D1 pool, bootstrap the operator, and deploy hosted Workers.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/deployment-target.sh"
environment_arg="${DEPLOY_ENVIRONMENT:-}"
target=all
dry_run=0
capacity_arg=""
while (($#)); do
  case "$1" in
    --environment) (($# >= 2)) || { printf '%s\n' 'deploy-hosted-workers: --environment requires a value' >&2; exit 1; }; environment_arg="$2"; shift 2 ;;
    --environment=*) environment_arg="${1#*=}"; shift ;;
    --target) (($# >= 2)) || { printf '%s\n' 'deploy-hosted-workers: --target requires a value' >&2; exit 1; }; target="$2"; shift 2 ;;
    --target=*) target="${1#*=}"; shift ;;
    --capacity) (($# >= 2)) || { printf '%s\n' 'deploy-hosted-workers: --capacity requires a value' >&2; exit 1; }; capacity_arg="$2"; shift 2 ;;
    --capacity=*) capacity_arg="${1#*=}"; shift ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) printf '%s\n' 'Usage: scripts/deploy-hosted-workers.sh [--environment staging|production] [--target api|coordinator|all] [--capacity 1..10] [--dry-run]'; exit 0 ;;
    *) printf '%s\n' "deploy-hosted-workers: unknown argument: $1" >&2; exit 1 ;;
  esac
done
select_deployment_environment "$repo_root" "$environment_arg"
case "$target" in api|coordinator|all) ;; *) printf '%s\n' 'deploy-hosted-workers: target must be api, coordinator, or all' >&2; exit 1 ;; esac
provision_args=(--environment "$deployment_environment")
[[ -n "$capacity_arg" ]] && provision_args+=(--capacity "$capacity_arg")
((dry_run)) && provision_args+=(--dry-run)
"$repo_root/scripts/provision-tenant-pool.sh" "${provision_args[@]}"
if ((dry_run)); then
  printf '%s\n' 'deploy-hosted-workers: dry-run, skipping operator bootstrap writes' >&2
else
  bootstrap="$repo_root/scripts/bootstrap-operator-workspace.sh"
  [[ -x "$bootstrap" ]] || { printf '%s\n' 'deploy-hosted-workers: bootstrap script is missing' >&2; exit 1; }
  "$bootstrap" --environment "$deployment_environment"
fi
if [[ "$deployment_environment" == staging ]]; then
  api_config="$repo_root/deploy/cloudflare/staging/oauth-api/wrangler.toml"
  coordinator_config="$repo_root/deploy/cloudflare/staging/hosted-coordinator/wrangler.toml"
else
  api_config="$repo_root/deploy/cloudflare/hosted/api.wrangler.toml"
  coordinator_config="$repo_root/deploy/cloudflare/hosted/coordinator.wrangler.toml"
fi
extra=()
((dry_run)) && extra+=(--dry-run)
if [[ "$target" == api || "$target" == all ]]; then
  pnpm --filter @uptime/api-worker exec wrangler deploy --config "$api_config" "${extra[@]}"
fi
if [[ "$target" == coordinator || "$target" == all ]]; then
  pnpm --filter @uptime/coordinator-worker exec wrangler deploy --config "$coordinator_config" "${extra[@]}"
fi
