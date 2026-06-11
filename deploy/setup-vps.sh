#!/usr/bin/env bash
# First-time setup for the EE Social vault server on Ubuntu 24.04 (Hermes VPS).
# Run as root (or sudo):  bash deploy/setup-vps.sh
#
# Integrates with an existing nginx + sslip.io setup (the Hermes convention):
# the vault server runs on 127.0.0.1:47321 and nginx reverse-proxies the
# subdomain social.<ip>.sslip.io to it, with Let's Encrypt TLS via certbot.
# Idempotent: safe to re-run.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ee-social-media}"
ENV_FILE="/etc/ee-social-media.env"
DOMAIN="social.149.28.133.149.sslip.io"
LE_EMAIL="${LE_EMAIL:-zhihong0321@gmail.com}"
REPO="https://github.com/Zhihong0321/ee-social-media.git"

echo "==> EE Social vault setup (app dir: $APP_DIR, domain: $DOMAIN)"

# --- 1. App code ------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi
cd "$APP_DIR"

# --- 2. Node deps + Playwright browser --------------------------------------
echo "==> npm install + Playwright browser libs"
npm install --omit=dev
# Real Chrome is preferred (less bot-detectable); chromium is the fallback.
if ! command -v google-chrome >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable xvfb
npx --yes playwright install --with-deps chromium || true

# --- 3. Admin token + env file ----------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(openssl rand -hex 32)"
  echo "VAULT_SECRET=$TOKEN" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "==> Generated admin token (stored in $ENV_FILE):"
  echo "    $TOKEN"
else
  echo "==> Reusing existing admin token in $ENV_FILE"
fi

# --- 4. systemd service -----------------------------------------------------
NODE_BIN="$(command -v node)"
cp "$APP_DIR/deploy/vault-server.service" /etc/systemd/system/ee-social.service
sed -i "s#/opt/ee-social-media#$APP_DIR#g; s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/vault-server/server.js#" /etc/systemd/system/ee-social.service
systemctl daemon-reload
systemctl enable --now ee-social
echo "    ee-social: $(systemctl is-active ee-social)"

# --- 5. nginx reverse proxy -------------------------------------------------
cp "$APP_DIR/deploy/nginx-ee-social.conf" /etc/nginx/sites-available/ee-social
ln -sf /etc/nginx/sites-available/ee-social /etc/nginx/sites-enabled/ee-social
nginx -t && systemctl reload nginx

# --- 6. TLS via certbot (only our subdomain) --------------------------------
if ! command -v certbot >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx
fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect

echo ""
echo "==> Done."
echo "    URL       : https://$DOMAIN/"
echo "    Health    : curl https://$DOMAIN/health"
echo "    Extension : Vault URL = https://$DOMAIN/capture + paste the admin token."
