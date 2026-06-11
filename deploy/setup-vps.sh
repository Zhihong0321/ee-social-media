#!/usr/bin/env bash
# First-time setup for the EE Social vault server on Ubuntu 24.04 (Hermes VPS).
# Run as a sudo-capable user:  bash deploy/setup-vps.sh
#
# Idempotent: safe to re-run. It installs Node, Chrome, Playwright, xvfb, Caddy,
# generates the admin token, and installs+starts the systemd service.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ee-social-media}"
SERVICE_USER="${SERVICE_USER:-hermes}"
ENV_FILE="/etc/ee-social-media.env"
DOMAIN="149.28.133.149.sslip.io"

echo "==> EE Social vault setup (app dir: $APP_DIR, user: $SERVICE_USER)"

# --- 1. System packages -----------------------------------------------------
sudo apt-get update -y
sudo apt-get install -y curl git gnupg ca-certificates xvfb

# --- 2. Node.js 20 LTS ------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node $(node --version)"

# --- 3. Google Chrome (real channel; less bot-detectable than headless) -----
if ! command -v google-chrome >/dev/null 2>&1; then
  echo "==> Installing Google Chrome stable"
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y google-chrome-stable
fi

# --- 4. App code ------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  echo "==> Cloning repo into $APP_DIR"
  sudo git clone https://github.com/Zhihong0321/ee-social-media.git "$APP_DIR"
else
  echo "==> Updating existing checkout"
  sudo git -C "$APP_DIR" pull --ff-only
fi

# Ensure the service user owns the app dir (vault-data is written at runtime).
id -u "$SERVICE_USER" >/dev/null 2>&1 || sudo useradd -r -m -s /usr/sbin/nologin "$SERVICE_USER"
sudo chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

echo "==> Installing npm deps + Playwright browser libs"
sudo -u "$SERVICE_USER" bash -c "cd '$APP_DIR' && npm ci --omit=dev || npm install --omit=dev"
# --with-deps pulls the apt libraries Chromium/Chrome need; chromium is the fallback browser.
sudo "$APP_DIR/node_modules/.bin/playwright" install --with-deps chromium

# --- 5. Admin token + env file ----------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(openssl rand -hex 32)"
  echo "VAULT_SECRET=$TOKEN" | sudo tee "$ENV_FILE" >/dev/null
  sudo chmod 600 "$ENV_FILE"
  echo "==> Generated admin token (also stored in $ENV_FILE):"
  echo "    $TOKEN"
else
  echo "==> Reusing existing admin token in $ENV_FILE"
fi

# --- 6. systemd service -----------------------------------------------------
sudo cp "$APP_DIR/deploy/vault-server.service" /etc/systemd/system/vault-server.service
sudo sed -i "s#/opt/ee-social-media#$APP_DIR#g; s/^User=.*/User=$SERVICE_USER/" /etc/systemd/system/vault-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now vault-server
echo "    vault-server: $(systemctl is-active vault-server)"

# --- 7. Caddy (TLS reverse proxy) -------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
sudo cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl reload caddy || sudo systemctl restart caddy

# --- 8. Firewall (if ufw is active) -----------------------------------------
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
fi

echo ""
echo "==> Done."
echo "    Vault URL : https://$DOMAIN/"
echo "    UI        : open that URL and paste the admin token above."
echo "    Extension : set Vault URL = https://$DOMAIN/capture and paste the same token."
