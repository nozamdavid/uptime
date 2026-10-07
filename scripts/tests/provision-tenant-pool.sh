#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -r "$fixture"' EXIT
mkdir -p "$fixture/scripts" "$fixture/deploy/cloudflare/hosted" "$fixture/deploy/cloudflare/production"
cp "$root/scripts/provision-tenant-pool.sh" "$fixture/scripts/"
cp "$root/scripts/deployment-target.sh" "$fixture/scripts/"
cat > "$fixture/deploy/cloudflare/hosted/api.wrangler.toml" <<'EOF'
[[d1_databases]]
binding = "CONTROL_DB"
database_name = "uptime-control"
database_id = "261093f4-98e2-48c8-b84d-932b7f27af7f"
migrations_dir = "control"
[[d1_databases]]
binding = "PRODUCTION_IMPORTED_DB"
database_name = "uptime"
database_id = "17c009df-5b56-44cc-9776-73e0f1775b0f"
[[d1_databases]]
binding = "TENANT_DB_000"
database_name = "uptime-tenant-000"
database_id = "00000000-0000-4000-8000-000000000001"
migrations_dir = "tenant"
EOF
cat > "$fixture/deploy/cloudflare/hosted/coordinator.wrangler.toml" <<'EOF'
[[d1_databases]]
binding = "CONTROL_DB"
database_name = "uptime-control"
database_id = "261093f4-98e2-48c8-b84d-932b7f27af7f"
migrations_dir = "control"
[[d1_databases]]
binding = "PRODUCTION_IMPORTED_DB"
database_name = "uptime"
database_id = "17c009df-5b56-44cc-9776-73e0f1775b0f"
[[d1_databases]]
binding = "TENANT_DB_000"
database_name = "uptime-tenant-000"
database_id = "00000000-0000-4000-8000-000000000001"
migrations_dir = "tenant"
EOF
printf '%s\n' 'uptime-tenant-000|00000000-0000-4000-8000-000000000001' > "$fixture/inventory"
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
# Staging D1 is retired: provisioning fails before any Cloudflare call.
if "$fixture/scripts/provision-tenant-pool.sh" --environment staging --capacity 1 >/dev/null 2>&1; then exit 1; fi
[[ ! -s "$fixture/creates" && ! -s "$fixture/migrations" && ! -s "$fixture/slots" ]]

"$fixture/scripts/provision-tenant-pool.sh" --environment production --capacity 2 >/dev/null
first="$(wc -l < "$fixture/creates" | tr -d ' ')"
id="$(awk -F '|' '$1 == "TENANT_DB_000" {print $2; exit}' "$fixture/slots")"
awk -F '|' -v id="$id" '$1 == "TENANT_DB_000" {print $1 "|" id "|assigned"; next} {print}' "$fixture/slots" > "$fixture/slots.tmp"; mv "$fixture/slots.tmp" "$fixture/slots"
"$fixture/scripts/provision-tenant-pool.sh" --environment production --capacity 2 >/dev/null
second="$(wc -l < "$fixture/creates" | tr -d ' ')"
[[ "$first" == 1 && "$second" == "$first" ]] || exit 1
grep -q "^TENANT_DB_000|$id|assigned$" "$fixture/slots"
# An unregistered database containing data is rejected even if already bound.
awk -F '|' '$1 != "TENANT_DB_001"' "$fixture/slots" > "$fixture/slots.tmp"
mv "$fixture/slots.tmp" "$fixture/slots"
if MOCK_NONEMPTY=1 "$fixture/scripts/provision-tenant-pool.sh" --environment production --capacity 2 >/dev/null 2>&1; then exit 1; fi
! grep -q '^TENANT_DB_001|' "$fixture/slots"
grep -q "^TENANT_DB_000|$id|assigned$" "$fixture/slots"

production_id=00000000-0000-4000-8000-000000000001
printf '%s\n' \
  'uptime-control|261093f4-98e2-48c8-b84d-932b7f27af7f' \
  'uptime|17c009df-5b56-44cc-9776-73e0f1775b0f' \
  "uptime-tenant-000|$production_id" > "$fixture/inventory"
printf 'TENANT_DB_000|%s|deleting\n' "$production_id" > "$fixture/slots"
: > "$fixture/migrations"
: > "$fixture/creates"
"$fixture/scripts/provision-tenant-pool.sh" --environment production --capacity 1 >/dev/null
grep -qx uptime-control "$fixture/migrations"
! grep -qx uptime "$fixture/migrations"
! grep -qx uptime-tenant-000 "$fixture/migrations"
grep -q "^TENANT_DB_000|$production_id|deleting$" "$fixture/slots"
printf '%s\n' 'provision-tenant-pool idempotency tests passed'
