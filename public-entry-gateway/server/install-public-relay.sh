#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This installer must run as root." >&2
  exit 1
fi
: "${IGP_TUNNEL_PUBLIC_KEY:?IGP_TUNNEL_PUBLIC_KEY is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUNNEL_USER="igp-entry"
NGINX_TEMPLATE="${SCRIPT_DIR}/nginx/igp-public-entry.conf.template"
OFFLINE_PAGE="${SCRIPT_DIR}/nginx/offline.html"

if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nginx
  else
    echo "Unsupported package manager; install nginx first." >&2
    exit 1
  fi
fi

if ! id "${TUNNEL_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${TUNNEL_USER}"
fi
passwd -l "${TUNNEL_USER}" >/dev/null 2>&1 || true

install -d -m 700 -o "${TUNNEL_USER}" -g "${TUNNEL_USER}" "/home/${TUNNEL_USER}/.ssh"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:18080" %s\n' \
  "${IGP_TUNNEL_PUBLIC_KEY}" \
  > "/home/${TUNNEL_USER}/.ssh/authorized_keys"
chown "${TUNNEL_USER}:${TUNNEL_USER}" "/home/${TUNNEL_USER}/.ssh/authorized_keys"
chmod 600 "/home/${TUNNEL_USER}/.ssh/authorized_keys"

install -d -m 755 /var/www/igp-public-entry
install -m 644 "${OFFLINE_PAGE}" /var/www/igp-public-entry/offline.html

install -m 644 "${NGINX_TEMPLATE}" /etc/nginx/conf.d/igp-public-entry.conf

if [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

nginx -t
systemctl enable nginx
systemctl restart nginx

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --reload
fi

echo "IGP public entry relay installed."
