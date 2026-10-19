#!/bin/sh
# Run as root after the PostgreSQL backup succeeds.
set -eu
umask 077

# ExecStartPost=+ keeps the postgres service environment while granting root access.
RCLONE_CONFIG=/root/.config/rclone/rclone.conf
export RCLONE_CONFIG

CONFIG_DIR=/var/backups/uptime-staging-config
stamp=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$CONFIG_DIR"

set --
for path in \
  opt/uptime-staging/api.env \
  opt/uptime-staging/scheduler.env \
  opt/uptime-staging/gateway-token \
  opt/uptime-staging/catalog.json \
  opt/uptime-staging/docker-compose.yml \
  opt/uptime-staging-web/nginx.conf.template
do
  if [ -e "/$path" ]; then
    set -- "$@" "$path"
  fi
done

tar -czf "$CONFIG_DIR/config-$stamp.tar.gz.tmp" -C / -T /dev/null -- "$@"
mv "$CONFIG_DIR/config-$stamp.tar.gz.tmp" "$CONFIG_DIR/config-$stamp.tar.gz"
find "$CONFIG_DIR" -maxdepth 1 -type f -name 'config-*.tar.gz' -mtime +14 -delete

rclone copy /var/backups/postgresql gdrive-crypt:postgres -q \
  --include 'uptime_staging-2*.dump' \
  --include 'uptime_staging-globals-*.sql' --max-age 48h
rclone copy "$CONFIG_DIR" gdrive-crypt:config -q --max-age 48h
rclone delete gdrive-crypt: -q --min-age 30d
