#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root or with sudo."
  exit 1
fi

TURN_DOMAIN="${TURN_DOMAIN:-}"
TURN_EMAIL="${TURN_EMAIL:-}"
TURN_SHARED_SECRET="${TURN_SHARED_SECRET:-}"
TURN_PUBLIC_IP="${TURN_PUBLIC_IP:-}"
TURN_PUBLIC_HOST="${TURN_PUBLIC_HOST:-}"
TURN_REALM="${TURN_REALM:-}"
TURN_ENABLE_TLS="${TURN_ENABLE_TLS:-true}"
TURN_RELAY_MIN_PORT="${TURN_RELAY_MIN_PORT:-49160}"
TURN_RELAY_MAX_PORT="${TURN_RELAY_MAX_PORT:-49200}"

if [[ -z "${TURN_SHARED_SECRET}" || -z "${TURN_PUBLIC_IP}" ]]; then
  echo "Missing required environment variables."
  echo "Required:"
  echo "  TURN_SHARED_SECRET"
  echo "  TURN_PUBLIC_IP"
  exit 1
fi

if [[ -z "${TURN_PUBLIC_HOST}" ]]; then
  TURN_PUBLIC_HOST="${TURN_DOMAIN:-${TURN_PUBLIC_IP}}"
fi

if [[ -z "${TURN_REALM}" ]]; then
  TURN_REALM="${TURN_DOMAIN:-flightmanager-turn-test}"
fi

if [[ "${TURN_ENABLE_TLS}" != "true" && "${TURN_ENABLE_TLS}" != "false" ]]; then
  echo "TURN_ENABLE_TLS must be either true or false."
  exit 1
fi

if [[ "${TURN_ENABLE_TLS}" == "true" && ( -z "${TURN_DOMAIN}" || -z "${TURN_EMAIL}" ) ]]; then
  echo "TURN_ENABLE_TLS=true requires these environment variables too:"
  echo "  TURN_DOMAIN"
  echo "  TURN_EMAIL"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/turnserver.conf.template"
TARGET_CONFIG="/etc/turnserver.conf"

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "Template file not found: ${TEMPLATE_PATH}"
  exit 1
fi

echo "Installing Coturn and UFW..."
apt update
DEBIAN_FRONTEND=noninteractive apt install -y coturn ufw

if [[ "${TURN_ENABLE_TLS}" == "true" ]]; then
  echo "Installing Certbot for TLS setup..."
  DEBIAN_FRONTEND=noninteractive apt install -y certbot
fi

echo "Allowing firewall ports..."
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow "${TURN_RELAY_MIN_PORT}:${TURN_RELAY_MAX_PORT}/udp"

echo "Enabling Coturn service..."
sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

TLS_LISTENING_PORT_DIRECTIVE="# TLS disabled for this TURN deployment"
TLS_CERT_DIRECTIVES="# TLS disabled for this TURN deployment"

if [[ "${TURN_ENABLE_TLS}" == "true" ]]; then
  echo "Allowing TLS and ACME firewall ports..."
  ufw allow 80/tcp
  ufw allow 5349/tcp

  echo "Requesting Let's Encrypt certificate for ${TURN_DOMAIN}..."
  certbot certonly --standalone --non-interactive --agree-tos -m "${TURN_EMAIL}" -d "${TURN_DOMAIN}"

  CERT_PATH="/etc/letsencrypt/live/${TURN_DOMAIN}/fullchain.pem"
  KEY_PATH="/etc/letsencrypt/live/${TURN_DOMAIN}/privkey.pem"
  TLS_LISTENING_PORT_DIRECTIVE="tls-listening-port=5349"
  TLS_CERT_DIRECTIVES=$'cert='"${CERT_PATH}"$'\npkey='"${KEY_PATH}"
fi

echo "Writing Coturn configuration..."
sed \
  -e "s|__TURN_SHARED_SECRET__|${TURN_SHARED_SECRET}|g" \
  -e "s|__TURN_REALM__|${TURN_REALM}|g" \
  -e "s|__TURN_SERVER_NAME__|${TURN_PUBLIC_HOST}|g" \
  -e "s|__TURN_PUBLIC_IP__|${TURN_PUBLIC_IP}|g" \
  -e "s|__TURN_RELAY_MIN_PORT__|${TURN_RELAY_MIN_PORT}|g" \
  -e "s|__TURN_RELAY_MAX_PORT__|${TURN_RELAY_MAX_PORT}|g" \
  -e "s|__TURN_TLS_LISTENING_PORT_DIRECTIVE__|${TLS_LISTENING_PORT_DIRECTIVE}|g" \
  -e "s|__TURN_TLS_CERT_DIRECTIVES__|${TLS_CERT_DIRECTIVES}|g" \
  "${TEMPLATE_PATH}" > "${TARGET_CONFIG}"

echo "Restarting Coturn..."
systemctl restart coturn
systemctl enable coturn

echo
echo "Coturn setup completed."
echo "TURN public host: ${TURN_PUBLIC_HOST}"
echo "TURN realm: ${TURN_REALM}"
echo "TURN public IP: ${TURN_PUBLIC_IP}"
echo "TLS enabled: ${TURN_ENABLE_TLS}"
echo "Relay UDP range: ${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}"
echo
echo "Next:"
echo "1. Put the same TURN_SHARED_SECRET in the relay server environment variables."
echo "2. Set TURN_PUBLIC_HOST to ${TURN_PUBLIC_HOST} in the relay server environment variables."
if [[ "${TURN_ENABLE_TLS}" == "true" ]]; then
  echo "3. Keep TURN_ENABLE_TLS=true on the relay server."
else
  echo "3. Set TURN_ENABLE_TLS=false on the relay server."
fi
echo "4. Restart the relay server."
echo "5. Restart the Windows Sim Bridge host."
