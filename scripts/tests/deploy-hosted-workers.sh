#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
git() {
  case "$*" in
    *symbolic-ref*) printf '%s\n' "${DEPLOY_TEST_BRANCH:-main}" ;;
    *) command git "$@" ;;
  esac
}
pnpm() { printf '%s\n' "pnpm $*" >> "${DEPLOY_TEST_LOG:-/dev/null}"; }
export -f git pnpm
log="$(mktemp)"
fixture_root="$(mktemp -d)"
trap 'rm -f "$log"; rm -rf "$fixture_root"' EXIT
export DEPLOY_TEST_LOG="$log"
"$root/scripts/deploy-hosted-workers.sh" --environment staging --capacity 3 --dry-run >/dev/null 2>&1 || fail 'staging deployment dry-run failed'
if grep -q 'd1 execute\|d1 create\|d1 migrations' "$log"; then fail 'dry-run performed a remote D1 write'; fi
: > "$log"
if "$root/scripts/deploy-hosted-workers.sh" --environment production --capacity 0 >/dev/null 2>&1; then fail 'provisioning validation failure was ignored'; fi
[[ ! -s "$log" ]] || fail 'worker deploy started after provisioning failure'
export DEPLOY_TEST_BRANCH=codex/product-release-plan
if "$root/scripts/deploy-hosted-workers.sh" --environment production --capacity 1 --dry-run >/dev/null 2>&1; then fail 'allowed protected production'; fi
: > "$log"

# Exercise the non-dry-run path without invoking Cloudflare or editing repo configs.
mkdir -p "$fixture_root/scripts" "$fixture_root/deploy/cloudflare/staging/vps-api-proxy" "$fixture_root/deploy/cloudflare/staging/hosted-coordinator"
ln -s "$root/scripts/deploy-hosted-workers.sh" "$fixture_root/scripts/deploy-hosted-workers.sh"
ln -s "$root/scripts/deployment-target.sh" "$fixture_root/scripts/deployment-target.sh"
ln -s /usr/bin/true "$fixture_root/scripts/provision-tenant-pool.sh"
ln -s /usr/bin/true "$fixture_root/scripts/bootstrap-operator-workspace.sh"
export DEPLOY_TEST_BRANCH=main
"$fixture_root/scripts/deploy-hosted-workers.sh" --environment staging --capacity 1 >/dev/null || fail 'staging deployment success path failed'
grep -Fq 'pnpm --filter @uptime/api-worker exec wrangler deploy --config ' "$log" || fail 'api worker deploy was not invoked'
grep -Fq 'pnpm --filter @uptime/coordinator-worker exec wrangler deploy --config ' "$log" || fail 'coordinator worker deploy was not invoked'
[[ "$(grep -c '^pnpm .* exec wrangler deploy ' "$log")" -eq 2 ]] || fail 'unexpected Wrangler invocation count'
if grep -q -- '--dry-run' "$log"; then fail 'non-dry-run worker deploy included --dry-run'; fi
printf '%s\n' 'deploy-hosted-workers tests passed'
