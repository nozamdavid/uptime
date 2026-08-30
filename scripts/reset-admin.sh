#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env"
mode=""
assume_yes=0
usage() { cat <<'EOF'
Usage: scripts/reset-admin.sh [--env-file PATH] --check
       scripts/reset-admin.sh [--env-file PATH] --apply [--yes]
Check or update the singleton admin. --apply invalidates existing sessions;
monitors and check history are preserved.
EOF
}
die() { echo "reset-admin: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --env-file) (($# >= 2)) || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --check|--apply) [[ -z "$mode" ]] || die "choose exactly one mode"; mode="${1#--}"; shift ;;
    --yes) assume_yes=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$mode" ]] || { usage >&2; exit 2; }
[[ "$mode" == "apply" || "$assume_yes" == 0 ]] || die "--yes is only valid with --apply"
[[ -f "$env_file" ]] || die "environment file not found: $env_file"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is required"
[[ -n "${ADMIN_EMAIL:-}" ]] || die "ADMIN_EMAIL is required"
[[ -n "${ADMIN_PASSWORD_HASH:-}" ]] || die "ADMIN_PASSWORD_HASH is required"
export RESET_ADMIN_MODE="$mode"
pnpm --filter @uptime/api exec node --input-type=module -e '
import argon2 from "argon2";
try { await argon2.verify(process.env.ADMIN_PASSWORD_HASH, "reset-admin-synthetic-password"); }
catch { console.error("reset-admin: ADMIN_PASSWORD_HASH is not a valid Argon2 PHC string"); process.exit(1); }
' || exit $?
if [[ "$mode" == "apply" && "$assume_yes" == 0 ]]; then
  printf 'Update the singleton admin and invalidate existing sessions? [y/N] '
  read -r confirmation
  [[ "$confirmation" == "y" || "$confirmation" == "Y" ]] || die "cancelled"
fi
pnpm --filter @uptime/database exec node --input-type=module -e '
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  if (process.env.RESET_ADMIN_MODE === "check") {
    const admins = await sql`select id, password_hash from admins where singleton_key = true`;
    if (admins.length !== 1) throw new Error(`expected exactly one singleton admin; found ${admins.length}`);
    const matches = admins[0].password_hash === process.env.ADMIN_PASSWORD_HASH;
    console.log(`admin count: ${admins.length}`); console.log(`environment hash matches stored: ${matches}`);
  } else {
    await sql.begin(async (tx) => {
      const admins = await tx`select id from admins where singleton_key = true for update`;
      if (admins.length !== 1) throw new Error(`expected exactly one singleton admin; found ${admins.length}`);
      await tx`update admins set email = ${process.env.ADMIN_EMAIL}, password_hash = ${process.env.ADMIN_PASSWORD_HASH}, updated_at = now() where id = ${admins[0].id}`;
      await tx`delete from sessions where admin_id = ${admins[0].id}`;
    });
    console.log("admin credentials updated; existing sessions invalidated");
  }
} catch (error) { console.error(`reset-admin: ${error instanceof Error ? error.message : "database operation failed"}`); process.exitCode = 1; }
finally { await sql.end(); }
'
