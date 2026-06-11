const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const VAULT_DIR = path.join(ROOT, "vault-data");
const CAPTURE_DIR = path.join(VAULT_DIR, "captures");
const CREDENTIAL_DIR = path.join(VAULT_DIR, "credentials");
const KEY_FILE = path.join(VAULT_DIR, ".vault-key");
const PROFILE_DIR = path.join(VAULT_DIR, "browser-profiles", "facebook-agent");
const ARTIFACT_DIR = path.join(VAULT_DIR, "agent-runs", "facebook");

async function runFacebookHelloWorld(options = {}) {
  const postText = options.postText || process.env.POST_TEXT || "Hello world";
  const headless = options.headless ?? process.env.HEADLESS === "1";

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const capture = loadLatestFacebookCapture();
  const credential = loadCredentialForHost("facebook.com");

  // BROWSER_CHANNEL="chrome" uses real Google Chrome (install it on the VPS);
  // set it to "chromium" (or "") to use Playwright's bundled browser instead.
  const channel = process.env.BROWSER_CHANNEL === undefined ? "chrome" : process.env.BROWSER_CHANNEL;
  const launchOptions = {
    headless,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    userAgent: capture?.browser?.userAgent
  };
  if (channel) launchOptions.channel = channel;
  // Chrome refuses to run as root without --no-sandbox; the VPS service runs as root.
  if (process.platform === "linux") {
    launchOptions.args = ["--no-sandbox", "--disable-dev-shm-usage"];
  }

  console.log(`[agent] launching sandboxed browser profile (channel: ${channel || "bundled chromium"}, headless: ${headless})`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);

  try {
    await restoreCaptureIntoContext(context, capture);
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });
    await settle(page);
    await screenshot(page, "01-home");

    await ensureLoggedIn(page, credential);
    await screenshot(page, "02-logged-in");

    await postHelloWorld(page, postText);
    await screenshot(page, "03-post-submitted");

    console.log(`[agent] VALIDATED: submitted Facebook post text "${postText}"`);
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  runFacebookHelloWorld().catch((error) => {
    console.error(`[agent] FAILED: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  runFacebookHelloWorld
};

async function ensureLoggedIn(page, credential) {
  if (await looksLoggedIn(page)) {
    console.log("[agent] already logged in");
    return;
  }

  console.log("[agent] not logged in or checkpointed; attempting credential login");
  if (!credential) {
    throw new Error("Facebook credential not found in local vault. Save one first or restore a working session.");
  }

  await fillCredentialIfPresent(page, credential);
  await clickLikelyLoginButton(page);
  await settle(page, 5000);

  if (await isPasswordCheckpoint(page)) {
    console.log("[agent] password checkpoint detected; filling saved password");
    await fillVisiblePassword(page, credential.password);
    await clickByNames(page, [/continue/i, /submit/i, /log in/i]);
    await settle(page, 7000);
  }

  if (await requiresHuman(page)) {
    await screenshot(page, "needs-human");
    throw new Error("Facebook requires human verification/2FA/checkpoint. Screenshot saved under vault-data/agent-runs/facebook.");
  }

  if (!(await looksLoggedIn(page))) {
    await screenshot(page, "login-not-confirmed");
    throw new Error("Login did not reach a normal Facebook session.");
  }
}

async function postHelloWorld(page, postText) {
  await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });
  await settle(page);

  const composer = await firstLocator(page, [
    page.getByRole("button", { name: /what.*on.*your.*mind/i }),
    page.getByText(/what.*on.*your.*mind/i).first(),
    page.locator('[aria-label*="Create a post" i]').first()
  ]);

  if (!composer) {
    throw new Error("Could not find Facebook post composer.");
  }

  await composer.click({ timeout: 5000 });
  await settle(page, 2000);
  await handleFacebookPopups(page);

  const editor = await firstLocator(page, [
    page.getByRole("textbox", { name: /what.*on.*your.*mind/i }),
    page.locator('div[contenteditable="true"][role="textbox"]').last(),
    page.locator('div[contenteditable="true"]').last()
  ]);

  if (!editor) {
    throw new Error("Could not find Facebook post editor.");
  }

  await editor.click({ force: true });
  await page.keyboard.type(postText, { delay: 15 });
  await settle(page, 1000);
  await screenshot(page, "post-draft");

  const postButton = await firstLocator(page, [
    page.getByRole("button", { name: /^post$/i }),
    page.locator('[aria-label="Post"]').first()
  ]);

  if (!postButton) {
    throw new Error("Could not find Facebook Post button.");
  }

  await postButton.click();
  await settle(page, 8000);
}

async function handleFacebookPopups(page) {
  const popupButtons = [
    /got it/i,
    /continue/i,
    /next/i,
    /done/i,
    /save/i,
    /ok/i,
    /not now/i,
    /maybe later/i,
    /close/i
  ];

  for (let i = 0; i < 4; i += 1) {
    let clicked = false;
    for (const name of popupButtons) {
      const button = page.getByRole("button", { name }).last();
      if (await button.isVisible({ timeout: 700 }).catch(() => false)) {
        await button.click({ timeout: 2000 }).catch(() => {});
        await settle(page, 1000);
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 500);
      return;
    }
  }
}

async function looksLoggedIn(page) {
  if (await page.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(() => false)) {
    return false;
  }
  if (await isPasswordCheckpoint(page)) {
    return false;
  }

  const loggedInSignals = [
    page.locator('[aria-label="Facebook"]').first(),
    page.locator('[aria-label="Home"]').first(),
    page.getByRole("button", { name: /your profile|account|menu/i }).first(),
    page.getByText(/what.*on.*your.*mind/i).first()
  ];

  for (const signal of loggedInSignals) {
    if (await signal.isVisible({ timeout: 1500 }).catch(() => false)) {
      return true;
    }
  }

  return false;
}

async function fillCredentialIfPresent(page, credential) {
  const email = page.locator('input[name="email"], input[type="email"], input[autocomplete="username"]').first();
  const pass = page.locator('input[name="pass"], input[type="password"], input[autocomplete="current-password"]').first();

  if (await email.isVisible().catch(() => false)) {
    await email.fill(credential.username);
  }
  if (await pass.isVisible().catch(() => false)) {
    await pass.fill(credential.password);
  }
}

async function fillVisiblePassword(page, password) {
  const pass = page.locator('input[type="password"], input[name="pass"]').first();
  if (!(await pass.isVisible().catch(() => false))) {
    throw new Error("Password checkpoint found, but no password field is visible.");
  }
  await pass.fill(password);
}

async function clickLikelyLoginButton(page) {
  await clickByNames(page, [/log in/i, /login/i, /continue/i]);
}

async function clickByNames(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible({ timeout: 1200 }).catch(() => false)) {
      await button.click();
      return true;
    }
  }

  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
    return true;
  }

  return false;
}

async function isPasswordCheckpoint(page) {
  return page.getByText(/enter your password to continue|re-enter your password/i)
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
}

async function requiresHuman(page) {
  const texts = [
    /two-factor authentication/i,
    /enter the code/i,
    /security check/i,
    /checkpoint/i,
    /confirm your identity/i,
    /captcha/i,
    /suspicious/i
  ];

  for (const text of texts) {
    if (await page.getByText(text).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function firstLocator(page, locators) {
  for (const locator of locators) {
    if (await locator.isVisible({ timeout: 2500 }).catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function restoreCaptureIntoContext(context, capture) {
  if (!capture) {
    console.log("[agent] no Facebook session capture found; credential login only");
    return;
  }

  const cookies = (capture.cookies || [])
    .map(toPlaywrightCookie)
    .filter(Boolean);

  if (cookies.length) {
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  await page.goto(capture.page?.origin || "https://www.facebook.com/", { waitUntil: "domcontentloaded" });
  await page.evaluate(({ localStorageData, sessionStorageData }) => {
    for (const [key, value] of Object.entries(localStorageData || {})) {
      window.localStorage.setItem(key, value);
    }
    for (const [key, value] of Object.entries(sessionStorageData || {})) {
      window.sessionStorage.setItem(key, value);
    }
  }, {
    localStorageData: capture.localStorage || {},
    sessionStorageData: capture.sessionStorage || {}
  });
  await page.close();

  console.log(`[agent] restored latest Facebook capture (${cookies.length} cookies)`);
}

function toPlaywrightCookie(cookie) {
  if (!cookie?.name || typeof cookie.value !== "string") return null;
  const domain = String(cookie.domain || "").replace(/^\./, "");
  const secure = Boolean(cookie.secure);
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || domain,
    path: cookie.path || "/",
    expires: cookie.session ? -1 : Math.floor(cookie.expirationDate || -1),
    httpOnly: Boolean(cookie.httpOnly),
    secure,
    sameSite: toPlaywrightSameSite(cookie.sameSite)
  };
}

function toPlaywrightSameSite(value) {
  if (value === "strict") return "Strict";
  if (value === "lax") return "Lax";
  if (value === "no_restriction") return "None";
  return "Lax";
}

function loadLatestFacebookCapture() {
  if (!fs.existsSync(CAPTURE_DIR)) return null;
  const metas = fs.readdirSync(CAPTURE_DIR)
    .filter((file) => file.endsWith(".meta.json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, file), "utf8")))
    .filter((meta) => /(^|\.)facebook\.com$/i.test(meta.hostname || ""))
    .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));

  if (!metas.length) return null;
  return loadEncrypted(path.join(CAPTURE_DIR, `${metas[0].id}.json.enc`));
}

function loadCredentialForHost(hostname) {
  if (!fs.existsSync(CREDENTIAL_DIR)) return null;
  for (const candidate of credentialCandidates(hostname)) {
    const file = path.join(CREDENTIAL_DIR, `${candidate}.json.enc`);
    if (fs.existsSync(file)) {
      const credential = loadEncrypted(file);
      console.log(`[agent] loaded saved credential for ${credential.hostname} (${credential.username})`);
      return credential;
    }
  }
  return null;
}

function credentialCandidates(hostname) {
  const parts = String(hostname).toLowerCase().split(".");
  const candidates = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    candidates.push(parts.slice(i).join(".").replace(/[^a-z0-9.-]/g, "_"));
  }
  return candidates;
}

function loadEncrypted(file) {
  const key = Buffer.from(fs.readFileSync(KEY_FILE, "utf8"), "base64");
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function settle(page, ms = 3000) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(ms);
}

async function screenshot(page, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(ARTIFACT_DIR, `${stamp}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}
