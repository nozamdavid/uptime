#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -r "$fixture"' EXIT
mkdir -p "$fixture/scripts" "$fixture/deploy/cloudflare/staging/oauth-api" "$fixture/deploy/cloudflare/staging/hosted-coordinator"
cp "$root/scripts/provision-tenant-pool.sh" "$fixture/scripts/"
cp "$root/scripts/deployment-target.sh" "$fixture/scripts/"
printf '%s\n' 'name = "control"' > "$fixture/deploy/cloudflare/staging/oauth-api/wrangler.toml"
printf '%s\n' 'name = "coordinator"' > "$fixture/deploy/cloudflare/staging/hosted-coordinator/wrangler.toml"
printf '%s\n' 'uptime-staging-control|00000000-0000-4000-8000-000000000001' > "$fixture/inventory"
: > "$fixture/slots"
: > "$fixture/creates"
: > "$fixture/migrations"
export MOCK_FIXTURE="$fixture"
git() { case "$*" in *symbolic-ref*) printf '%s\n' main ;; *) command git "$@" ;; esac; }
pnpm() {
  local name id text b database
  while (($#)); do [[ "$1" == wrangler ]] && { shift; break; }; shift; done
  [[ "$1" == d1 ]] || return 0
  shift
  case "$1" in
    migrations) printf '%s\n' "$3" >> "$MOCK_FIXTURE/migrations"; return 0 ;;
    list) jq -Rn '[inputs | split("|") | {name: .[0], uuid: .[1]}]' < "$MOCK_FIXTURE/inventory" ;;
    create)
      name="$2"; id="$(printf '00000000-0000-4000-8000-%012d' "$(($(wc -l < "$MOCK_FIXTURE/inventory") + 2))")"
      printf '%s|%s\n' "$name" "$id" >> "$MOCK_FIXTURE/inventory"; printf '%s\n' "$name" >> "$MOCK_FIXTURE/creates" ;;
    execute)
      database="$2"
      text=""; while (($#)); do [[ "$1" == --command ]] && { text="$2"; shift 2; continue; }; shift; done
      [[ "$text" == *max_workspaces* ]] && { printf '%s\n' '[{"results":[{"max_workspaces":1}]}]'; return; }
      if [[ "$text" == *'FROM tenant_slots'* ]]; then
        b="${text##*binding_name=\'}"; b="${b%%\'*}"
        jq -Rn --arg b "$b" '[inputs | split("|") | select(.[0] == $b) | {binding_name: .[0], database_id: .[1], status: .[2]}] | [{results: .}]' < "$MOCK_FIXTURE/slots"
        return
      fi
      if [[ "$text" == *'AS used'* ]]; then
        grep -qx "$database" "$MOCK_FIXTURE/migrations" || return 1
        printf '[{"results":[{"used":%s}]}]\n' "${MOCK_NONEMPTY:-0}"
        return
      fi
      if [[ "$text" == INSERT*tenant_slots* ]]; then
        b="${text#*VALUES(\'}"; b="${b%%\'*}"; id="${text#*,\'}"; id="${id%%\'*}"
        grep -q "^$b|" "$MOCK_FIXTURE/slots" || printf '%s|%s|available\n' "$b" "$id" >> "$MOCK_FIXTURE/slots"
      fi ;;
  esac
}
export -f git pnpm
"$fixture/scripts/provision-tenant-pool.sh" --environment staging --capacity 1 >/dev/null
first="$(wc -l < "$fixture/creates" | tr -d ' ')"
id="$(awk -F '|' '$1 == "TENANT_DB_000" {print $2; exit}' "$fixture/slots")"
awk -F '|' -v id="$id" '$1 == "TENANT_DB_000" {print $1 "|" id "|assigned"; next} {print}' "$fixture/slots" > "$fixture/slots.tmp"; mv "$fixture/slots.tmp" "$fixture/slots"
"$fixture/scripts/provision-tenant-pool.sh" --environment staging --capacity 1 >/dev/null
second="$(wc -l < "$fixture/creates" | tr -d ' ')"
[[ "$first" == 4 && "$second" == "$first" ]] || exit 1
grep -q "^TENANT_DB_000|$id|assigned$" "$fixture/slots"
before="$(cat "$fixture/slots")"
# An unregistered database containing data is rejected even if already bound.
awk -F '|' '$1 != "STAGING_TEST_DB_002"' "$fixture/slots" > "$fixture/slots.tmp"
mv "$fixture/slots.tmp" "$fixture/slots"
if MOCK_NONEMPTY=1 "$fixture/scripts/provision-tenant-pool.sh" --environment staging --capacity 1 >/dev/null 2>&1; then exit 1; fi
! grep -q '^STAGING_TEST_DB_002|' "$fixture/slots"
grep -q "^TENANT_DB_000|$id|assigned$" "$fixture/slots"
printf '%s\n' 'provision-tenant-pool idempotency tests passed'
