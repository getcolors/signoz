#!/usr/bin/env bash
# Disaster recovery for the Postgres metastore only.
#
# The metastore holds the irreplaceable state: users, dashboards, alert rules,
# saved views. The telemetry databases are deliberately not backed up — they
# are regenerable, they age out on their own retention, and a hot copy races
# ClickHouse's merges. Restoring a deployment means `./green create` plus this
# dump, not a filesystem image.
set -euo pipefail

. /etc/signoz/backup.env

dir="/var/backups/signoz"
bucket="signoz-backup"
profile="signoz-digitalocean-fixture"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$dir/metastore-$stamp.sql.gz"

mkdir -p "$dir"

# pg_dump inside the container, so the dump is taken by the same major version
# that wrote the data.
docker compose -f /opt/signoz/compose.yml exec -T metastore \
  pg_dump -U signoz -d signoz --clean --if-exists | gzip -9 > "$file"

# An empty or truncated dump is worse than no dump, because it looks like a
# backup. gzip -t proves the stream is complete before anything is uploaded.
gzip -t "$file"
if [ ! -s "$file" ]; then
  echo "signoz-backup: $file is empty" >&2
  exit 1
fi

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENV_AUTH=false
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$SIGNOZ_BACKUP_R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://example.eu.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_REGION="auto"

rclone copy "$file" "r2:$bucket/$profile/"

# This deployment owns only its own prefix. Retention never reaches outside it.
rclone delete --min-age 7d "r2:$bucket/$profile/"
find "$dir" -name 'metastore-*.sql.gz' -mtime +7 -delete

echo "signoz-backup: uploaded $(basename "$file") to r2:$bucket/$profile/"
