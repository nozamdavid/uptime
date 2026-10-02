#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

log_file="$tmp/pnpm.log"
secret_file="$tmp/secrets.env"
touch "$secret_file"

pnpm() {
  printf '%s\n' "$*" >> "$DEPLOY_APP_WORKERS_TEST_LOG"
  if [[ "${DEPLOY_APP_WORKERS_TEST_FAIL:-0}" == "1" ]]; then
    return 23
  fi
}
export -f pnpm
git() {
  case "$*" in
    *symbolic-ref*) printf '%s\n' "$DEPLOY_TEST_BRANCH" ;;
    *) command git "$@" ;;
  esac
}
export -f git
export DEPLOY_TEST_BRANCH=main
export DEPLOY_APP_WORKERS_TEST_LOG="$log_file"

# Missing secrets file is rejected.
set +e
"$root/scripts/deploy-app-workers.sh" --secrets-file "$tmp/nope.env" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]]

# Dry runs deploy bundles but never invoke the remote migration command.
"$root/scripts/deploy-app-workers.sh" --dry-run --secrets-file "$secret_file" >/dev/null
[[ "$(wc -l < "$log_file" | tr -d '[:space:]')" -eq 2 ]]
! grep -q "migrations apply" "$log_file"
[[ "$(sed -n '1p' "$log_file")" == *"--filter @uptime/api-worker exec wrangler deploy --config $root/deploy/cloudflare/api/wrangler.toml --dry-run --secrets-file $secret_file"* ]]
[[ "$(sed -n '2p' "$log_file")" == *"--filter @uptime/coordinator-worker exec wrangler deploy --config $root/deploy/cloudflare/coordinator/wrangler.toml --dry-run --secrets-file $secret_file"* ]]

# --target api deploys only the API Worker.
: > "$log_file"
"$root/scripts/deploy-app-workers.sh" --target api --dry-run >/dev/null
[[ "$(wc -l < "$log_file" | tr -d '[:space:]')" -eq 1 ]]
[[ "$(sed -n '1p' "$log_file")" == *"wrangler.toml"* ]]
[[ "$(sed -n '1p' "$log_file")" == *"@uptime/api-worker"* ]]

# Real deployment applies shared migrations before deploying either Worker.
: > "$log_file"
"$root/scripts/deploy-app-workers.sh" >/dev/null
[[ "$(wc -l < "$log_file" | tr -d '[:space:]')" -eq 3 ]]
[[ "$(sed -n '1p' "$log_file")" == *"d1 migrations apply uptime --remote --config $root/deploy/cloudflare/api/wrangler.toml"* ]]
[[ "$(sed -n '2p' "$log_file")" == *"@uptime/api-worker"* ]]
[[ "$(sed -n '3p' "$log_file")" == *"@uptime/coordinator-worker"* ]]

# --target coordinator deploys only the coordinator Worker.
: > "$log_file"
"$root/scripts/deploy-app-workers.sh" --target coordinator --dry-run >/dev/null
[[ "$(sed -n '1p' "$log_file")" == *"@uptime/coordinator-worker"* ]]

# A deployment failure stops the script with the provider status.
: > "$log_file"
set +e
DEPLOY_APP_WORKERS_TEST_FAIL=1 "$root/scripts/deploy-app-workers.sh" --dry-run >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 23 ]]
[[ "$(wc -l < "$log_file" | tr -d '[:space:]')" -eq 1 ]]

# A bad target is rejected before any deployment.
set +e
"$root/scripts/deploy-app-workers.sh" --target nope >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]]

# The release branch defaults to staging, including migration targets.
: > "$log_file"
DEPLOY_TEST_BRANCH=codex/product-release-plan "$root/scripts/deploy-app-workers.sh" >/dev/null
[[ "$(sed -n '1p' "$log_file")" == *"d1 migrations apply uptime-staging --remote --config $root/deploy/cloudflare/staging/api/wrangler.toml"* ]]
[[ "$(sed -n '2p' "$log_file")" == *"--config $root/deploy/cloudflare/staging/api/wrangler.toml"* ]]
[[ "$(sed -n '3p' "$log_file")" == *"--config $root/deploy/cloudflare/staging/coordinator/wrangler.toml"* ]]

# CLI targeting takes precedence over the environment variable.
: > "$log_file"
DEPLOY_ENVIRONMENT=production "$root/scripts/deploy-app-workers.sh" --environment=staging --dry-run >/dev/null
[[ "$(sed -n '1p' "$log_file")" == *"/staging/api/wrangler.toml"* ]]

# Production is rejected before migrations or deployments on the release branch.
for requested in cli variable; do
  : > "$log_file"
  set +e
  if [[ "$requested" == cli ]]; then
    DEPLOY_TEST_BRANCH=codex/product-release-plan "$root/scripts/deploy-app-workers.sh" --environment production >/dev/null 2>&1
  else
    DEPLOY_TEST_BRANCH=codex/product-release-plan DEPLOY_ENVIRONMENT=production "$root/scripts/deploy-app-workers.sh" >/dev/null 2>&1
  fi
  status=$?
  set -e
  [[ "$status" -eq 1 ]]
  [[ ! -s "$log_file" ]]
done

echo "deploy-app-workers shell tests passed"
