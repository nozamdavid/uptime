#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="$repo_root/deploy/cloudflare"

regions_list="${REGIONS_LIST:-}"
if [[ -z "$regions_list" && -f "$repo_root/.env" ]]; then
  regions_line="$(grep -E '^[[:space:]]*REGIONS_LIST=' "$repo_root/.env" | tail -n 1 || true)"
  if [[ -n "$regions_line" ]]; then
    regions_list="${regions_line#*=}"
    regions_list="$(printf '%s' "$regions_list" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    if [[ "$regions_list" == \"*\" && "$regions_list" == *\" ]]; then
      regions_list="${regions_list:1:${#regions_list}-2}"
    elif [[ "$regions_list" == \'*\' && "$regions_list" == *\' ]]; then
      regions_list="${regions_list:1:${#regions_list}-2}"
    fi
  fi
fi

configs=()
if [[ -n "$regions_list" ]]; then
  seen_regions=()
  IFS=',' read -r -a configured_regions <<< "$regions_list"
  for raw_region in "${configured_regions[@]}"; do
    region="$(printf '%s' "$raw_region" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    if [[ ! "$region" =~ ^[a-z0-9-]+$ ]]; then
      printf 'deploy-workers: invalid region in REGIONS_LIST: %s\n' "$raw_region" >&2
      exit 1
    fi
    for seen_region in "${seen_regions[@]:-}"; do
      if [[ "$seen_region" == "$region" ]]; then
        printf 'deploy-workers: duplicate region in REGIONS_LIST: %s\n' "$region" >&2
        exit 1
      fi
    done
    config="$config_dir/wrangler.$region.toml"
    if [[ ! -f "$config" ]]; then
      printf 'deploy-workers: no Wrangler config for REGIONS_LIST region %s\n' "$region" >&2
      exit 1
    fi
    seen_regions+=("$region")
    configs+=("$config")
  done
else
  shopt -s nullglob
  config_candidates=("$config_dir"/wrangler.*.toml)
  shopt -u nullglob
  if ((${#config_candidates[@]} > 0)); then
    while IFS= read -r config; do
      [[ -n "$config" ]] && configs+=("$config")
    done < <(printf '%s\n' "${config_candidates[@]}" | LC_ALL=C sort)
  fi
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
