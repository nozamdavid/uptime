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
trap 'rm -f "$log"' EXIT
export DEPLOY_TEST_LOG="$log"
"$root/scripts/deploy-hosted-workers.sh" --environment staging --capacity 3 --dry-run >/dev/null 2>&1 || fail 'staging deployment dry-run failed'
if grep -q 'd1 execute\|d1 create\|d1 migrations' "$log"; then fail 'dry-run performed a remote D1 write'; fi
: > "$log"
if "$root/scripts/deploy-hosted-workers.sh" --environment staging --capacity 0 >/dev/null 2>&1; then fail 'provisioning validation failure was ignored'; fi
[[ ! -s "$log" ]] || fail 'worker deploy started after provisioning failure'
export DEPLOY_TEST_BRANCH=codex/product-release-plan
if "$root/scripts/deploy-hosted-workers.sh" --environment production --capacity 1 --dry-run >/dev/null 2>&1; then fail 'allowed protected production'; fi
printf '%s\n' 'deploy-hosted-workers tests passed'
