#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="$repo_root/deploy/cloudflare"

shopt -s nullglob
config_candidates=("$config_dir"/wrangler.*.toml)
shopt -u nullglob

configs=()
if ((${#config_candidates[@]} > 0)); then
  while IFS= read -r config; do
    [[ -n "$config" ]] && configs+=("$config")
  done < <(printf '%s\n' "${config_candidates[@]}" | LC_ALL=C sort)
fi

if ((${#configs[@]} == 0)); then
  printf 'deploy-workers: no Wrangler configs found in %s\n' "$config_dir" >&2
  exit 1
fi

cd -- "$repo_root"
for config in "${configs[@]}"; do
  printf 'deploy-workers: deploying %s\n' "$(basename -- "$config")" >&2
  if pnpm --filter @uptime/probe-worker exec wrangler deploy --config "$config" "$@"; then
    continue
  else
    status=$?
    printf 'deploy-workers: deployment failed for %s\n' "$(basename -- "$config")" >&2
    exit "$status"
  fi
done

printf 'deploy-workers: deployed %d worker configuration(s)\n' "${#configs[@]}" >&2
