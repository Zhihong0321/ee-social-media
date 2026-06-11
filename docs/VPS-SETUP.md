# Hermes VPS Setup Guide

First-time setup to run the EE Social vault + posting agent on your Hermes VPS
(`149.28.133.149`, Ubuntu 24.04), reachable at `https://social.149.28.133.149.sslip.io`.

> This VPS already runs **nginx** with `*.sslip.io` subdomains (open-webui,
> hermes-dashboard, etc.). We integrate with that instead of installing Caddy:
> the vault server listens on `127.0.0.1:47321` and nginx proxies the
> `social.<ip>.sslip.io` subdomain to it, with Let's Encrypt TLS via certbot.

End state:
- Laptop Chrome extension captures a logged-in session and pushes it to the VPS.
- A web UI on the VPS lets you view captures and store username/password logins.
- A Playwright agent on the VPS uses that session to post to social media.

---

## Do I need a browser on the VPS?

**Yes.** Playwright drives a real browser, not HTTP calls. The setup script installs
**Google Chrome** + **xvfb** (a virtual display) so the agent runs *headed* on a
GUI-less server — this is far less bot-detectable than pure headless mode.
Playwright's bundled Chromium is also installed as a fallback.

---

## One-command install

SSH into the VPS and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Zhihong0321/ee-social-media/main/deploy/setup-vps.sh -o setup-vps.sh
bash setup-vps.sh
```

The script (see [`deploy/setup-vps.sh`](../deploy/setup-vps.sh)) is idempotent and:

1. Clones the repo to `/opt/ee-social-media` and runs `npm install`.
2. Installs Google Chrome + xvfb (and Playwright's chromium as fallback).
3. **Generates an admin token** and prints it — copy it now.
4. Installs and starts the `ee-social` **systemd** service (localhost:47321).
5. Adds an nginx site for `social.149.28.133.149.sslip.io` → the vault server.
6. Runs **certbot** to get a Let's Encrypt cert for that subdomain (HTTPS + redirect).

When it finishes you'll see your admin token and the URL.

---

## Verify

```bash
systemctl status ee-social          # should be active (running)
curl https://social.149.28.133.149.sslip.io/health   # {"ok":true,...}
```

Open `https://social.149.28.133.149.sslip.io/` in a browser → paste the admin token → unlock.

---

## Point the laptop extension at the VPS

1. Load the extension (Chrome → `chrome://extensions` → Developer mode → Load
   unpacked → select the `extension/` folder).
2. Open the extension popup and set:
   - **Vault URL**: `https://social.149.28.133.149.sslip.io/capture`
   - **Admin token**: the same token from setup.
3. Log in to a platform (e.g. Facebook) in a normal tab → click **Capture This Site**.
4. In the VPS web UI, the capture appears under **Captures**.

---

## Post from the VPS

In the web UI → **Post** tab → choose `facebook`, enter text, **Post now**.
The agent restores the latest capture, logs in if needed, posts, and shows screenshots.

> **Expect a checkpoint the first time.** Logging in from a datacenter IP often
> triggers Facebook 2FA / "confirm it's you". The agent screenshots and stops when
> it hits one ([`requiresHuman`](../agents/facebook-hello-world.js)); resolve it,
> re-capture a fresh session from the laptop, and retry.

---

## Operations

```bash
# Logs
journalctl -u ee-social -f

# Restart after pulling new code
cd /opt/ee-social-media && git pull --ff-only && systemctl restart ee-social

# Rotate the admin token
sed -i "s/VAULT_SECRET=.*/VAULT_SECRET=$(openssl rand -hex 32)/" /etc/ee-social-media.env
systemctl restart ee-social     # then update the token in the UI + extension
```

## Security notes

- `vault-data/` holds **live session material** (AES-256-GCM encrypted at rest with
  `vault-data/.vault-key`). It is gitignored — never commit it.
- The admin token is the only wall between the internet and your sessions. Keep it
  secret; rotate if leaked.
- Only ports 80/443 need to be public. The vault server itself stays on `127.0.0.1`.
