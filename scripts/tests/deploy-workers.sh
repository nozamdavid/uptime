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

export DEPLOY_WORKERS_TEST_LOG="$log_file"
export PATH="$stub_dir:$PATH"

PATH="$stub_dir:$PATH" "$root/scripts/deploy-workers.sh" --dry-run --secrets-file "$secret_file" >/dev/null
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
DEPLOY_WORKERS_TEST_FAIL=1 "$root/scripts/deploy-workers.sh" --dry-run >/dev/null 2>"$tmp_dir/failure.log"
status=$?
set -e
[[ "$status" -eq 17 ]]
failed_call_count="$(wc -l < "$log_file" | tr -d '[:space:]')"
[[ "$failed_call_count" -eq 1 ]]
grep -Fq 'deployment failed for wrangler.asia-east.toml' "$tmp_dir/failure.log"

echo "deploy-workers shell tests passed"
