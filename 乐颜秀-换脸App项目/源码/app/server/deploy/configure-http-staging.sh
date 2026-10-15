#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi
if [[ ${ALLOW_INSECURE_HTTP_STAGING:-} != yes ]]; then
  echo "Refusing cleartext staging. Re-run with ALLOW_INSECURE_HTTP_STAGING=yes only for a debug APK with non-sensitive test data." >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 0644 "$script_dir/nginx-http-staging.conf" /etc/nginx/sites-available/leyanxiu-api
ln -sfn /etc/nginx/sites-available/leyanxiu-api /etc/nginx/sites-enabled/leyanxiu-api
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "Temporary cleartext staging is available on port 80. Do not upload real personal data."

