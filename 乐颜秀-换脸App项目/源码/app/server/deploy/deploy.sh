#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
server_dir=$(cd -- "$script_dir/.." && pwd)
env_file=/etc/leyanxiu/server.env
tag=${1:-$(date -u +%Y%m%dT%H%M%SZ)}

if [[ ! $tag =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Release tag contains unsupported characters." >&2
  exit 1
fi
if [[ ! -r $env_file ]]; then
  echo "Missing $env_file. Copy the example, fill it locally on the host, then chmod 600." >&2
  exit 1
fi
if [[ $(stat -c '%a' "$env_file") != 600 ]]; then
  echo "$env_file must have mode 600." >&2
  exit 1
fi

cd "$server_dir"
IMAGE_TAG="$tag" docker compose -f deploy/compose.yml build --pull
IMAGE_TAG="$tag" docker compose -f deploy/compose.yml up -d --remove-orphans

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:3000/health >/dev/null; then
    printf '%s\n' "$tag" > /opt/leyanxiu/current-image-tag
    echo "Deployment healthy: leyanxiu-api:${tag}"
    exit 0
  fi
  sleep 2
done

docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail=100 api
echo "Deployment did not become healthy." >&2
exit 1

