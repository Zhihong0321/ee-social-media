// Login-only probe: restores the latest Facebook capture and reports whether
// the replayed session is accepted (logged in) WITHOUT posting anything.
// This is the make-or-break test for session replay on a different IP/device.
//
//   node agents/facebook-login-probe.js   (wrap in xvfb-run on a headless VPS)
//
// Prints one of: LOGGED_IN | NEEDS_HUMAN | LOGGED_OUT, plus a screenshot path.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const VAULT_DIR = path.join(ROOT, "vault-data");
const CAPTURE_DIR = path.join(VAULT_DIR, "captures");
const KEY_FILE = path.join(VAULT_DIR, ".vault-key");
const PROFILE_DIR = path.join(VAULT_DIR, "browser-profiles", "facebook-probe");
const ARTIFACT_DIR = path.join(VAULT_DIR, "agent-runs", "facebook");

(async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const capture = loadLatestFacebookCapture();
  if (!capture) {
    console.log("RESULT: NO_CAPTURE — push a Facebook capture from the laptop first.");
    process.exit(2);
  }
  console.log(`[probe] using capture with ${capture.cookies?.length || 0} cookies, UA: ${capture.browser?.userAgent ? "yes" : "no"}`);

  const channel = process.env.BROWSER_CHANNEL === undefined ? "chrome" : process.env.BROWSER_CHANNEL;
  const launchOptions = {
    headless: process.env.HEADLESS === "1",
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    userAgent: capture.browser?.userAgent
  };
  if (channel) launchOptions.channel = channel;
  if (process.platform === "linux") launchOptions.args = ["--no-sandbox", "--disable-dev-shm-usage"];

  console.log(`[probe] launching ${channel || "chromium"}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  try {
    await restoreCapture(context, capture);
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);

    const shot = path.join(ARTIFACT_DIR, `${stamp()}_probe.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

    const title = await page.title().catch(() => "");
    const url = page.url();
    let result = "LOGGED_OUT";
    if (await needsHuman(page)) result = "NEEDS_HUMAN";
    else if (await looksLoggedIn(page)) result = "LOGGED_IN";

    console.log(`[probe] title="${title}" url=${url}`);
    console.log(`[probe] screenshot: ${shot}`);
    console.log(`RESULT: ${result}`);
    process.exit(result === "LOGGED_IN" ? 0 : 1);
  } finally {
    await context.close();
  }
})().catch((e) => { console.error("PROBE_ERROR:", e.message); process.exit(3); });

async function looksLoggedIn(page) {
  if (await page.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(() => false)) return false;
  const signals = [
    page.locator('[aria-label="Facebook"]').first(),
    page.locator('[aria-label="Home"]').first(),
    page.getByText(/what.*on.*your.*mind/i).first()
  ];
  for (const s of signals) if (await s.isVisible({ timeout: 1500 }).catch(() => false)) return true;
  return false;
}

async function needsHuman(page) {
  const texts = [/two-factor/i, /enter the code/i, /security check/i, /checkpoint/i, /confirm your identity/i, /captcha/i, /your account has been locked/i, /we need to confirm/i];
  for (const t of texts) if (await page.getByText(t).first().isVisible({ timeout: 800 }).catch(() => false)) return true;
  return false;
}

async function restoreCapture(context, capture) {
  const cookies = (capture.cookies || []).map(toPwCookie).filter(Boolean);
  if (cookies.length) await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(capture.page?.origin || "https://www.facebook.com/", { waitUntil: "domcontentloaded" });
  await page.evaluate(({ ls, ss }) => {
    for (const [k, v] of Object.entries(ls || {})) window.localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(ss || {})) window.sessionStorage.setItem(k, v);
  }, { ls: capture.localStorage || {}, ss: capture.sessionStorage || {} });
  await page.close();
}

function toPwCookie(c) {
  if (!c?.name || typeof c.value !== "string") return null;
  return {
    name: c.name, value: c.value,
    domain: c.domain || String(c.domain || "").replace(/^\./, ""),
    path: c.path || "/",
    expires: c.session ? -1 : Math.floor(c.expirationDate || -1),
    httpOnly: Boolean(c.httpOnly), secure: Boolean(c.secure),
    sameSite: c.sameSite === "strict" ? "Strict" : c.sameSite === "no_restriction" ? "None" : "Lax"
  };
}

function loadLatestFacebookCapture() {
  if (!fs.existsSync(CAPTURE_DIR)) return null;
  const metas = fs.readdirSync(CAPTURE_DIR)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, f), "utf8")))
    .filter((m) => /(^|\.)facebook\.com$/i.test(m.hostname || ""))
    .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
  if (!metas.length) return null;
  const key = Buffer.from(fs.readFileSync(KEY_FILE, "utf8"), "base64");
  const p = JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, `${metas[0].id}.json.enc`), "utf8"));
  const dec = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64"));
  dec.setAuthTag(Buffer.from(p.tag, "base64"));
  return JSON.parse(Buffer.concat([dec.update(Buffer.from(p.data, "base64")), dec.final()]).toString());
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
