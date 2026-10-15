#!/usr/bin/env bash
set -Eeuo pipefail

domain=${1:-}
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

echo "== Host =="
uname -a
free -h
df -h / /var/lib/leyanxiu 2>/dev/null || df -h /

echo "== Configuration permissions =="
stat -c '%a %U:%G %n' /etc/leyanxiu/server.env
test "$(stat -c '%a' /etc/leyanxiu/server.env)" = 600

echo "== Compose =="
docker compose -f deploy/compose.yml config --quiet
docker compose -f deploy/compose.yml ps

echo "== Local health =="
curl --fail --silent --show-error http://127.0.0.1:3000/health
echo

if [[ -n $domain ]]; then
  echo "== Public HTTPS =="
  curl --fail --silent --show-error "https://${domain}/health"
  echo
  curl --fail --silent --show-error \
    -H 'Origin: https://localhost' \
    -D - -o /dev/null "https://${domain}/health" \
    | grep -i '^access-control-allow-origin: https://localhost'
fi

