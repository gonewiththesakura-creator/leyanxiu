#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/install-host.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates docker.io nginx certbot fail2ban unattended-upgrades

if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker-compose-v2 2>/dev/null \
    || apt-get install -y docker-compose-plugin 2>/dev/null \
    || { echo "Docker Compose v2 is unavailable from the configured repositories." >&2; exit 1; }
fi

install -d -m 0750 /opt/leyanxiu
install -d -m 0700 /etc/leyanxiu
install -d -m 0750 \
  /var/lib/leyanxiu/data \
  /var/lib/leyanxiu/private-objects \
  /var/lib/leyanxiu/reports \
  /var/lib/leyanxiu/reports/capabilities \
  /var/lib/leyanxiu/logs \
  /var/lib/leyanxiu/work \
  /var/backups/leyanxiu
install -d -m 0755 /var/www/letsencrypt
install -d -o root -g root -m 0755 /var/www/leyanxiu-downloads

# The image runs as the standard Node image user (uid/gid 1000).
chown -R 1000:1000 /var/lib/leyanxiu

systemctl enable --now docker nginx fail2ban unattended-upgrades
echo "Host packages and directories are ready. Firewall/security-group changes are intentionally not automated."
