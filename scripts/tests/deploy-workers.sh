#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

stub_dir="$tmp_dir/bin"
log_file="$tmp_dir/pnpm.log"
secret_file="$tmp_dir/dummy-secrets-file"
touch "$secret_file"

pnpm() {
  printf '%s\n' "$*" >> "$DEPLOY_WORKERS_TEST_LOG"
  if [[ "${DEPLOY_WORKERS_TEST_FAIL:-0}" == "1" ]]; then
    return 17
  fi
}
export -f pnpm

git() {
  case "$*" in
    *symbolic-ref*) printf '%s\n' "${DEPLOY_TEST_BRANCH:-main}" ;;
    *) command git "$@" ;;
  esac
}
export -f git

export DEPLOY_WORKERS_TEST_LOG="$log_file"
export PATH="$stub_dir:$PATH"
export DEPLOY_TEST_BRANCH=main

all_regions='asia-east,asia-south,asia,canada-central,eu-north,eu-south,eu-west,us-east,us-west'
REGIONS_LIST="$all_regions" PATH="$stub_dir:$PATH" \
  "$root/scripts/deploy-workers.sh" --dry-run --secrets-file "$secret_file" >/dev/null
call_count="$(wc -l < "$log_file" | tr -d '[:space:]')"
expected_configs=()
while IFS= read -r config; do
  [[ -n "$config" ]] && expected_configs+=("$config")
done < <(rg --only-matching 'wrangler\.[a-z0-9-]+\.toml' "$root/packages/regions/src/index.ts" | LC_ALL=C sort)
[[ "${#expected_configs[@]}" -eq 9 ]]
[[ "$call_count" -eq "${#expected_configs[@]}" ]]

for index in "${!expected_configs[@]}"; do
  call="$(sed -n "$((index + 1))p" "$log_file")"
  expected_config="${expected_configs[$index]}"
  [[ "$call" == *"--config $root/deploy/cloudflare/$expected_config --dry-run --secrets-file $secret_file"* ]]
done

: > "$log_file"
set +e
REGIONS_LIST="$all_regions" DEPLOY_WORKERS_TEST_FAIL=1 \
  "$root/scripts/deploy-workers.sh" --dry-run >/dev/null 2>"$tmp_dir/failure.log"
status=$?
set -e
[[ "$status" -eq 17 ]]
failed_call_count="$(wc -l < "$log_file" | tr -d '[:space:]')"
[[ "$failed_call_count" -eq 1 ]]
grep -Fq 'deployment failed for wrangler.asia-east.toml' "$tmp_dir/failure.log"

: > "$log_file"
REGIONS_LIST='asia-east,asia-south' PATH="$stub_dir:$PATH" \
  "$root/scripts/deploy-workers.sh" --dry-run >/dev/null
[[ "$(wc -l < "$log_file" | tr -d '[:space:]')" -eq 2 ]]
[[ "$(sed -n '1p' "$log_file")" == *'wrangler.asia-east.toml'* ]]
[[ "$(sed -n '2p' "$log_file")" == *'wrangler.asia-south.toml'* ]]

: > "$log_file"
REGIONS_LIST='asia-east,asia-south' DEPLOY_ENVIRONMENT=staging PATH="$stub_dir:$PATH" \
  "$root/scripts/deploy-workers.sh" --dry-run --environment=staging --secrets-file "$secret_file" >/dev/null
[[ "$(wc -l < "$log_file" | tr -d '[:space:]')" -eq 2 ]]
[[ "$(sed -n '1p' "$log_file")" == *"--config $root/deploy/cloudflare/staging/probes/wrangler.asia-east.toml --dry-run --secrets-file $secret_file"* ]]
[[ "$(sed -n '2p' "$log_file")" == *"--config $root/deploy/cloudflare/staging/probes/wrangler.asia-south.toml --dry-run --secrets-file $secret_file"* ]]

: > "$log_file"
set +e
DEPLOY_TEST_BRANCH=codex/product-release-plan DEPLOY_ENVIRONMENT=production \
  "$root/scripts/deploy-workers.sh" --dry-run >/dev/null 2>"$tmp_dir/protected.log"
status=$?
set -e
[[ "$status" -eq 1 ]]
[[ ! -s "$log_file" ]]

for blocked_config_arg in '--config' '-c' '--config=other.toml' '-c=other.toml' '--name' '--name=uptime-probe-eu-west' '--env=production' '--route=uptime.noz.am' '--dispatch-namespace=production'; do
  : > "$log_file"
  set +e
  DEPLOY_TEST_BRANCH=main "$root/scripts/deploy-workers.sh" --dry-run "$blocked_config_arg" >/dev/null 2>"$tmp_dir/blocked-config.log"
  status=$?
  set -e
  [[ "$status" -eq 1 ]]
  [[ ! -s "$log_file" ]]
done

set +e
REGIONS_LIST='asia-east,unknown' PATH="$stub_dir:$PATH" \
  "$root/scripts/deploy-workers.sh" --dry-run >/dev/null 2>"$tmp_dir/invalid.log"
status=$?
set -e
[[ "$status" -eq 1 ]]
grep -Fq 'no Wrangler config for REGIONS_LIST region unknown' "$tmp_dir/invalid.log"

echo "deploy-workers shell tests passed"
