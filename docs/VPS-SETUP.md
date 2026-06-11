# Hermes VPS Setup Guide

First-time setup to run the EE Social vault + posting agent on your Hermes VPS
(`149.28.133.149`, Ubuntu 24.04), reachable at `https://149.28.133.149.sslip.io`.

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

1. Installs Node 20, Git, Chrome, xvfb.
2. Clones the repo to `/opt/ee-social-media`.
3. `npm ci` + `playwright install --with-deps chromium`.
4. **Generates an admin token** and prints it — copy it now.
5. Installs and starts the `vault-server` **systemd** service (localhost:47321).
6. Installs **Caddy**, which gets a real HTTPS cert for `149.28.133.149.sslip.io`
   and reverse-proxies to the vault server.
7. Opens firewall ports 80/443 if `ufw` is active.

When it finishes you'll see your admin token and the URL.

---

## Verify

```bash
systemctl status vault-server          # should be active (running)
curl https://149.28.133.149.sslip.io/health   # {"ok":true,...}
```

Open `https://149.28.133.149.sslip.io/` in a browser → paste the admin token → unlock.

---

## Point the laptop extension at the VPS

1. Load the extension (Chrome → `chrome://extensions` → Developer mode → Load
   unpacked → select the `extension/` folder).
2. Open the extension popup and set:
   - **Vault URL**: `https://149.28.133.149.sslip.io/capture`
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
journalctl -u vault-server -f

# Restart after pulling new code
cd /opt/ee-social-media && sudo git pull --ff-only && sudo systemctl restart vault-server

# Rotate the admin token
sudo sed -i "s/VAULT_SECRET=.*/VAULT_SECRET=$(openssl rand -hex 32)/" /etc/ee-social-media.env
sudo systemctl restart vault-server     # then update the token in the UI + extension
```

## Security notes

- `vault-data/` holds **live session material** (AES-256-GCM encrypted at rest with
  `vault-data/.vault-key`). It is gitignored — never commit it.
- The admin token is the only wall between the internet and your sessions. Keep it
  secret; rotate if leaked.
- Only ports 80/443 need to be public. The vault server itself stays on `127.0.0.1`.
