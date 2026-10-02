#!/usr/bin/env bash
# Validate Cloudflare deployment tooling using a fake pnpm executable.
# No deployment or network access is performed.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"

scripts/tests/deploy-app-workers.sh

printf 'cloudflare tooling tests passed\n'
