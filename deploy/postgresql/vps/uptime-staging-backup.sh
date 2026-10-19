#!/bin/sh
# Nightly backup of the uptime_staging database, run as the postgres user by
# uptime-staging-backup.service. Keeps dated dumps for RETENTION_DAYS days and
# points uptime_staging-latest.dump at the newest one.
set -eu

BACKUP_DIR=/var/backups/postgresql
RETENTION_DAYS=14
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="$BACKUP_DIR/uptime_staging-$stamp.dump"
globals="$BACKUP_DIR/uptime_staging-globals-$stamp.sql"

umask 077
pg_dump -d uptime_staging -Fc -f "$dump.tmp"
# Fails the run if the archive is unreadable.
pg_restore --list "$dump.tmp" > /dev/null
mv "$dump.tmp" "$dump"
# Roles and their settings (statement_timeout, passwords) live outside the database dump.
pg_dumpall --globals-only > "$globals"
ln -sfn "$dump" "$BACKUP_DIR/uptime_staging-latest.dump"

find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'uptime_staging-2*.dump' -o -name 'uptime_staging-globals-*.sql' \) \
  -mtime +"$RETENTION_DAYS" -delete
