#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 /path/to/app.apk version-label [public-base-url]" >&2
  exit 1
fi

source_apk=$1
version=$2
public_base=${3:-http://REDACTED_COMPANY_INFRASTRUCTURE}
if [[ ! -f $source_apk ]] || [[ $source_apk != *.apk ]]; then
  echo "Source must be an existing APK file." >&2
  exit 1
fi
if [[ ! $version =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Version label contains unsupported characters." >&2
  exit 1
fi
if [[ ! $public_base =~ ^https?://[A-Za-z0-9.:-]+$ ]]; then
  echo "Public base URL is invalid." >&2
  exit 1
fi

name="leyanxiu-${version}.apk"
destination="/var/www/leyanxiu-downloads/${name}"
install -o root -g root -m 0644 "$source_apk" "$destination"
sha256sum "$destination" > "${destination}.sha256"

echo "APK: ${public_base}/downloads/${name}"
echo "SHA-256: $(sha256sum "$destination" | awk '{print $1}')"

