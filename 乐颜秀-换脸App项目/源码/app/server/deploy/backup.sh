#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

backup_dir=/var/backups/leyanxiu
stamp=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0750 "$backup_dir"
tar --create --gzip --file "$backup_dir/state-${stamp}.tar.gz" \
  --directory /var/lib/leyanxiu data reports
find "$backup_dir" -maxdepth 1 -type f -name 'state-*.tar.gz' -mtime +14 -delete
echo "Created $backup_dir/state-${stamp}.tar.gz"

