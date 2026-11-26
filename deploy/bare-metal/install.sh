#!/usr/bin/env bash
# OzPrint v3.0 — Ubuntu/Debian Bare-Metal (Zero-Docker) Installer
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: install.sh must be run as root (sudo ./deploy/bare-metal/install.sh)" >&2
  exit 1
fi

# Detect the user who owns the repo (the user who cloned it)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_OWNER="$(stat -c '%U' "${REPO_DIR}")"

echo "==> [1/5] Installing OS dependencies (CUPS, Poppler, Python 3, build tools)..."
apt-get update -y
apt-get install -y \
  cups \
  cups-client \
  cups-bsd \
  poppler-utils \
  python3 \
  python3-pip \
  build-essential \
  curl \
  ca-certificates

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> [2/5] Preparing storage directory /var/lib/ozprint..."
mkdir -p /var/lib/ozprint /etc/ozprint
chown -R "${REPO_OWNER}:${REPO_OWNER}" /var/lib/ozprint
chmod 0750 /var/lib/ozprint

echo "==> [3/5] Installing Python worker dependencies..."
pip3 install --break-system-packages -r "${REPO_DIR}/workers/requirements.txt" || \
  pip3 install -r "${REPO_DIR}/workers/requirements.txt"

echo "==> [4/5] Building OzPrint monorepo..."
cd "${REPO_DIR}"
npm ci
npm run build

if [[ ! -f /etc/ozprint/ozprint.env ]]; then
  cp "${REPO_DIR}/.env.example" /etc/ozprint/ozprint.env
  RANDOM_SECRET="$(head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64)"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${RANDOM_SECRET}|" /etc/ozprint/ozprint.env
  chmod 0640 /etc/ozprint/ozprint.env
  chown "root:${REPO_OWNER}" /etc/ozprint/ozprint.env
fi

sed -i "s|^STORAGE_ROOT=.*|STORAGE_ROOT=/var/lib/ozprint|" /etc/ozprint/ozprint.env
sed -i "s|^SQLITE_PATH=.*|SQLITE_PATH=/var/lib/ozprint/ozprint.db|" /etc/ozprint/ozprint.env
sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" /etc/ozprint/ozprint.env

echo "==> [5/5] Installing and restarting systemd unit ozprint.service..."
# Patch the service file with the actual repo path and owner before installing
sed "s|/home/maverick/Ozprint|${REPO_DIR}|g; s|User=maverick|User=${REPO_OWNER}|g" \
  "${REPO_DIR}/deploy/bare-metal/ozprint.service" > /etc/systemd/system/ozprint.service

systemctl daemon-reload
systemctl enable ozprint.service
systemctl restart ozprint.service

echo "OzPrint v3.0 installed and running on port 4000! (running as ${REPO_OWNER})"
