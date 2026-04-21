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
TURN_RELAY_MIN_PORT="${TURN_RELAY_MIN_PORT:-49160}"
TURN_RELAY_MAX_PORT="${TURN_RELAY_MAX_PORT:-49200}"

if [[ -z "${TURN_DOMAIN}" || -z "${TURN_EMAIL}" || -z "${TURN_SHARED_SECRET}" || -z "${TURN_PUBLIC_IP}" ]]; then
  echo "Missing required environment variables."
  echo "Required:"
  echo "  TURN_DOMAIN"
  echo "  TURN_EMAIL"
  echo "  TURN_SHARED_SECRET"
  echo "  TURN_PUBLIC_IP"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/turnserver.conf.template"
TARGET_CONFIG="/etc/turnserver.conf"

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "Template file not found: ${TEMPLATE_PATH}"
  exit 1
fi

echo "Installing Coturn, Certbot, and UFW..."
apt update
DEBIAN_FRONTEND=noninteractive apt install -y coturn certbot ufw

echo "Allowing firewall ports..."
ufw allow 80/tcp
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow "${TURN_RELAY_MIN_PORT}:${TURN_RELAY_MAX_PORT}/udp"

echo "Requesting Let's Encrypt certificate for ${TURN_DOMAIN}..."
certbot certonly --standalone --non-interactive --agree-tos -m "${TURN_EMAIL}" -d "${TURN_DOMAIN}"

echo "Enabling Coturn service..."
sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

CERT_PATH="/etc/letsencrypt/live/${TURN_DOMAIN}/fullchain.pem"
KEY_PATH="/etc/letsencrypt/live/${TURN_DOMAIN}/privkey.pem"

echo "Writing Coturn configuration..."
sed \
  -e "s|__TURN_SHARED_SECRET__|${TURN_SHARED_SECRET}|g" \
  -e "s|__TURN_REALM__|${TURN_DOMAIN}|g" \
  -e "s|__TURN_SERVER_NAME__|${TURN_DOMAIN}|g" \
  -e "s|__TURN_PUBLIC_IP__|${TURN_PUBLIC_IP}|g" \
  -e "s|__TURN_CERT__|${CERT_PATH}|g" \
  -e "s|__TURN_PKEY__|${KEY_PATH}|g" \
  -e "s|__TURN_RELAY_MIN_PORT__|${TURN_RELAY_MIN_PORT}|g" \
  -e "s|__TURN_RELAY_MAX_PORT__|${TURN_RELAY_MAX_PORT}|g" \
  "${TEMPLATE_PATH}" > "${TARGET_CONFIG}"

echo "Restarting Coturn..."
systemctl restart coturn
systemctl enable coturn

echo
echo "Coturn setup completed."
echo "TURN domain: ${TURN_DOMAIN}"
echo "TURN public IP: ${TURN_PUBLIC_IP}"
echo "Relay UDP range: ${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}"
echo
echo "Next:"
echo "1. Put the same TURN_SHARED_SECRET in the relay server environment variables."
echo "2. Restart the relay server."
echo "3. Restart the Windows Sim Bridge host."
