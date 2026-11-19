#!/usr/bin/env bash
# OzPrint v3.0 — Ubuntu/Debian Bare-Metal (Zero-Docker) Installer
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: install.sh must be run as root (sudo ./deploy/bare-metal/install.sh)" >&2
  exit 1
fi

echo "==> [1/6] Installing OS dependencies (CUPS, Poppler, Python 3, build tools)..."
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

echo "==> [2/6] Provisioning least-privilege 'ozprint' service account in 'lp' group..."
if ! id -u ozprint >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin --gid lp ozprint
else
  usermod -a -G lp ozprint
fi

echo "==> [3/6] Preparing storage directory /var/lib/ozprint (0750)..."
mkdir -p /var/lib/ozprint /etc/ozprint /opt/ozprint
chown -R ozprint:lp /var/lib/ozprint
chmod 0750 /var/lib/ozprint

echo "==> [4/6] Installing Python worker dependencies..."
pip3 install --break-system-packages -r workers/requirements.txt || pip3 install -r workers/requirements.txt

echo "==> [5/6] Building OzPrint monorepo..."
cp -R . /opt/ozprint
cd /opt/ozprint
npm ci
npm run build
chown -R ozprint:lp /opt/ozprint

if [[ ! -f /etc/ozprint/ozprint.env ]]; then
  cp /opt/ozprint/.env.example /etc/ozprint/ozprint.env
  RANDOM_SECRET="$(head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64)"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${RANDOM_SECRET}|" /etc/ozprint/ozprint.env
  chmod 0640 /etc/ozprint/ozprint.env
  chown root:lp /etc/ozprint/ozprint.env
fi

echo "==> [6/6] Enabling and starting systemd unit ozprint.service..."
cp /opt/ozprint/deploy/bare-metal/ozprint.service /etc/systemd/system/ozprint.service
systemctl daemon-reload
systemctl enable ozprint.service
systemctl restart ozprint.service

echo "OzPrint v3.0 installed and running on port 4000!"
