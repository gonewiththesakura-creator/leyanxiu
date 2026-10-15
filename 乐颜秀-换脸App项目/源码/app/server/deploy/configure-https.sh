#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 api.example.com certificate-email@example.com" >&2
  exit 1
fi

domain=$1
email=$2
if [[ ! $domain =~ ^[A-Za-z0-9.-]+$ ]] || [[ $domain != *.* ]]; then
  echo "Invalid API domain." >&2
  exit 1
fi
if [[ ! $email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Invalid certificate email." >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
site=/etc/nginx/sites-available/leyanxiu-api
sed "s/__API_DOMAIN__/${domain}/g" "$script_dir/nginx-http.conf.template" > "$site"
ln -sfn "$site" /etc/nginx/sites-enabled/leyanxiu-api
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

certbot certonly --webroot -w /var/www/letsencrypt \
  --non-interactive --agree-tos --no-eff-email \
  --email "$email" -d "$domain"

sed "s/__API_DOMAIN__/${domain}/g" "$script_dir/nginx-https.conf.template" > "$site"
nginx -t
systemctl reload nginx
echo "HTTPS is ready at https://${domain}"

