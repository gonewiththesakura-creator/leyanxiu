#!/bin/bash
set -Eeuo pipefail
umask 077
# Run only after the owner authorizes the linked Let's Encrypt Subscriber Agreement.
test "${1:-}" = --certificate-terms-approved
test "$(id -u)" = 0
release=/opt/leyanxiu-app-account/releases/20260930-account
terms=https://letsencrypt.org/documents/LE-SA-v1.8-July-06-2026.pdf
current_terms=$(curl -fsS --max-time 20 https://acme-v02.api.letsencrypt.org/directory | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).meta.termsOfService))')
test "$current_terms" = "$terms" || { echo CERTIFICATE_TERMS_CHANGED >&2; exit 1; }
test -f /etc/nginx/sites-enabled/leyanxiu-app-http.conf
test ! -e /etc/nginx/sites-enabled/leyanxiu-app-https.conf
# HTTP-01 requires TCP 80 ingress. Only its challenge directory is served over HTTP.
contact=(--register-unsafely-without-email)
if test -n "${CERTIFICATE_CONTACT_EMAIL:-}"; then contact=(--email "$CERTIFICATE_CONTACT_EMAIL"); fi
certbot certonly --non-interactive --agree-tos "${contact[@]}" \
    --webroot -w /var/lib/leyanxiu-acme --cert-name REDACTED_COMPANY_INFRASTRUCTURE -d REDACTED_COMPANY_INFRASTRUCTURE \
    --key-type ecdsa --server https://acme-v02.api.letsencrypt.org/directory
openssl x509 -in /etc/letsencrypt/live/REDACTED_COMPANY_INFRASTRUCTURE/cert.pem -noout -checkhost REDACTED_COMPANY_INFRASTRUCTURE
openssl x509 -in /etc/letsencrypt/live/REDACTED_COMPANY_INFRASTRUCTURE/cert.pem -noout -checkend 604800
install -m 0644 "$release/deploy/nginx.app-account.conf.example" /etc/nginx/sites-available/leyanxiu-app-https.conf
ln -s /etc/nginx/sites-available/leyanxiu-app-https.conf /etc/nginx/sites-enabled/leyanxiu-app-https.conf
if ! nginx -t; then
    unlink /etc/nginx/sites-enabled/leyanxiu-app-https.conf
    exit 1
fi
# Only loopback can reach the API; Nginx overwrites all trusted client IP headers.
cp -p /etc/leyanxiu-app-account/server.env /etc/leyanxiu-app-account/server.env.before-https
sed -i 's/^TRUST_PROXY_HEADERS=false$/TRUST_PROXY_HEADERS=true/' /etc/leyanxiu-app-account/server.env
systemctl restart leyanxiu-app-account
systemctl reload nginx
install -m 0750 "$release/deploy/renew-app-https.sh" /etc/letsencrypt/renewal-hooks/deploy/leyanxiu-app-nginx
systemctl enable --now certbot.timer
verified=0
for attempt in $(seq 1 20); do
    if curl -fsS --max-time 5 --resolve REDACTED_COMPANY_INFRASTRUCTURE:443:127.0.0.1 https://REDACTED_COMPANY_INFRASTRUCTURE/health >/dev/null; then
        verified=1
        break
    fi
    sleep 1
done
if test "$verified" = 1; then
    echo APP_HTTPS_LOCAL_VERIFIED
    exit 0
fi
echo APP_HTTPS_HEALTH_FAILED >&2
exit 1
