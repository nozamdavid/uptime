#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$($root/scripts/reset-admin.sh --help)" == *"Usage:"* ]]
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<'EOF'
DATABASE_URL=postgresql://unused
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD_HASH='not-a-hash'
EOF
if "$root/scripts/reset-admin.sh" --env-file "$tmp" --check >/dev/null 2>&1; then echo "malformed hash unexpectedly accepted" >&2; exit 1; fi
echo "reset-admin shell tests passed"
