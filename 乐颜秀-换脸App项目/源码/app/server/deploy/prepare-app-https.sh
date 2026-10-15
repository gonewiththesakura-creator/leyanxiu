#!/bin/bash
set -Eeuo pipefail
umask 077
release=/opt/leyanxiu-app-account/releases/20260930-account
test "$(id -u)" = 0
test -f "$release/deploy/nginx.app-account-http.conf"
test -f /etc/leyanxiu-app-account/server.env
# First installation only: never replace an existing web service configuration.
test ! -e /etc/nginx/nginx.conf
if ss -lntH | awk '{print $4}' | grep -Eq ':(80|443)$'; then
    echo EXISTING_WEB_LISTENER >&2
    exit 1
fi
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
systemctl mask --runtime nginx.service
apt-get update -qq
apt-get install -y --no-install-recommends nginx certbot curl
# Keep the temporary mask if installation/configuration fails.
if test -L /etc/nginx/sites-enabled/default; then
    test "$(readlink -f /etc/nginx/sites-enabled/default)" = /etc/nginx/sites-available/default
    unlink /etc/nginx/sites-enabled/default
fi
install -d -m 0755 /var/lib/leyanxiu-acme/.well-known/acme-challenge
chmod 0755 /var/lib/leyanxiu-acme /var/lib/leyanxiu-acme/.well-known /var/lib/leyanxiu-acme/.well-known/acme-challenge
install -m 0644 "$release/deploy/nginx.app-account-http.conf" /etc/nginx/sites-available/leyanxiu-app-http.conf
ln -s /etc/nginx/sites-available/leyanxiu-app-http.conf /etc/nginx/sites-enabled/leyanxiu-app-http.conf
nginx -t
systemctl unmask --runtime nginx.service
systemctl enable --now nginx.service
# Select the already uploaded template asset root without deploying a Web App.
if ! test -f "$release/web/index.html"; then
    install -o root -g leyanxiu-app -m 0644 "$release/deploy/app-account-index.html" "$release/web/index.html"
    systemctl restart leyanxiu-app-account
fi
for attempt in $(seq 1 20); do
    if curl -fsS --max-time 3 http://127.0.0.1:3300/health >/dev/null; then break; fi
    sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:3300/effects/art-styles.webp >/dev/null
test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: REDACTED_COMPANY_INFRASTRUCTURE' http://127.0.0.1/api/account/login-status)" = 404
echo HTTPS_PREPARED_CERTIFICATE_NOT_REQUESTED
