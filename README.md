# EE Social Media Session Capture MVP

This project starts with a Chrome extension plus a local vault server.

The extension captures user-authorized browser state from the active social-media tab and sends it to a local vault server. The vault server writes encrypted capture bundles into this project folder so multiple browsers can feed one shared local vault.

## Run The Local Vault

```powershell
node .\vault-server\server.js
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:47321/health
```

Captures are saved under:

```text
vault-data\captures
```

Each capture writes:

- `<id>.json.enc`: encrypted sensitive bundle
- `<id>.meta.json`: non-secret summary

## Load The Extension

1. Open Chrome or Edge.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Click "Load unpacked".
5. Select `E:\ee-social-media\extension`.
6. Start the local vault server.
7. Open a logged-in social platform tab.
8. Click the extension and choose "Capture This Site".

## Incognito Restore Test

This is the key MVP test.

1. In normal Chrome, log in to a platform such as LinkedIn or X.
2. Click the extension and choose "Capture This Site".
3. Go to `chrome://extensions`.
4. Open this extension's details.
5. Enable "Allow in Incognito".
6. Open an incognito window.
7. Navigate to the same platform.
8. Click the extension and choose "Restore Latest For This Site".
9. The tab reloads. If you are logged in without entering username/password, the auth-replay thesis works for that platform.

If the platform asks for 2FA, checkpoint, or login, the platform likely binds the session to signals we have not restored yet.

## Credential Vault Login Test

For a more reliable fallback, explicitly save a login for the current site:

1. Open the site's login page.
2. Enter username/password in the extension popup.
3. Click "Save Login For This Site".
4. In normal or incognito browser, open that site's login page.
5. Click "Fill Saved Login".
6. The extension fills visible username/password fields. You still choose when to submit and handle 2FA/CAPTCHA.

This is intentionally explicit. The extension does not silently capture passwords typed into web pages.

## Security Notes

These captures contain live authenticated session material. Treat `vault-data` like a password vault.

- Do not commit `vault-data`.
- Do not paste decrypted captures into model context.
- Keep the vault local until encryption/key management is hardened.

## Decrypt A Capture For Debugging

```powershell
node .\vault-server\decrypt-capture.js .\vault-data\captures\<id>.json.enc
```

## Native MiniMax M3 Browser Smoke Test

This repo can call MiniMax-M3 directly through the native OpenAI-compatible MiniMax API. It does not use `mmx`.

Credential resolution:

1. `MINIMAX_M3_KEY` environment variable, matching the `claude-m3` launcher
2. `MINIMAX_API_KEY` environment variable
3. Hermes vault credential id `Minimax Token Plan`

Run:

```powershell
npm run m3:browser-smoke
```

The smoke test opens a harmless local page, screenshots it, sends the screenshot to MiniMax-M3 vision, asks for a JSON click decision, and lets Playwright execute the click.

If MiniMax returns `Token Plan usage limit reached (2056)`, wait for quota reset, upgrade the Token Plan, or add purchased credits.
