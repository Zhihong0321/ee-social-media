const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const VAULT_DIR = path.join(ROOT, "vault-data");
const ARTIFACT_DIR = path.join(VAULT_DIR, "agent-runs", "google-auth");
const EE2FA_URL = process.env.EE2FA_URL || "https://ee2fa.up.railway.app/";

async function runGoogleAuth(options = {}) {
  const username = options.username || process.env.GOOGLE_USERNAME;
  const password = options.password || process.env.GOOGLE_PASSWORD;
  const totpEmail = options.totpEmail || process.env.GOOGLE_TOTP_EMAIL || username;
  const profileName = options.profileName || process.env.GOOGLE_PROFILE_NAME || profileNameFor(username);
  const headless = options.headless ?? process.env.HEADLESS === "1";

  if (!username || !password) {
    throw new Error("GOOGLE_USERNAME and GOOGLE_PASSWORD are required.");
  }

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const profileDir = path.join(VAULT_DIR, "browser-profiles", profileName);
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto("https://accounts.google.com/signin/v2/identifier?service=accountsettings&continue=https%3A%2F%2Fmyaccount.google.com%2Femail", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await settle(page, 2500);
    await screenshot(page, "01-signin-start");

    await chooseExistingAccount(page, username);
    await submitEmailIfVisible(page, username);
    await screenshot(page, "02-email-submitted");

    await submitPasswordIfVisible(page, password);
    await screenshot(page, "03-password-submitted");

    await failFastForBlockingMessages(page);
    await handleTotpIfRequested(page, context, totpEmail);

    await dismissOptionalPrompts(page);
    await screenshot(page, "04-before-final-confirm");

    if (!(await confirmsTargetAccount(page, username))) {
      const text = await visibleText(page);
      throw new Error(`Target Google account not confirmed. URL=${page.url()} Text=${text.slice(0, 700)}`);
    }

    await screenshot(page, "05-final-target-confirmed");
    console.log("[google-auth] VALIDATED: target Google account authenticated");
  } finally {
    await context.close().catch(() => {});
  }
}

if (require.main === module) {
  runGoogleAuth().catch((error) => {
    console.error(`[google-auth] FAILED: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  runGoogleAuth
};

async function chooseExistingAccount(page, username) {
  const text = await visibleText(page);
  if (!text.includes(username)) return false;
  await page.getByText(username).first().click().catch(() => {});
  await settle(page, 2500);
  return true;
}

async function submitEmailIfVisible(page, username) {
  const email = page.locator('input[type="email"], input#identifierId').first();
  if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
    return false;
  }
  await email.fill(username);
  await clickByRoleText(page, /next/i);
  await settle(page, 3500);
  return true;
}

async function submitPasswordIfVisible(page, password) {
  const pass = page.locator('input[type="password"], input[name="Passwd"]').first();
  if (!(await pass.isVisible({ timeout: 12000 }).catch(() => false))) {
    return false;
  }
  await pass.fill(password);
  await clickByRoleText(page, /next/i);
  await settle(page, 5000);
  return true;
}

async function handleTotpIfRequested(page, context, email) {
  let text = await visibleText(page);
  if (/try another way/i.test(text)) {
    await clickByRoleText(page, /try another way/i);
    text = await visibleText(page);
  }

  if (/authenticator|verification code|google authenticator|get a code/i.test(text)) {
    await clickByRoleText(page, /google authenticator|authenticator app|get a verification code|enter.*code/i).catch(() => {});
    await settle(page, 1500);
  }

  const input = page.locator('input[name="totpPin"], input[type="tel"], input[aria-label*="code" i], input[type="text"]').first();
  if (!(await input.isVisible({ timeout: 8000 }).catch(() => false))) {
    return false;
  }

  const code = await readTotpFromEe2fa(context, email);
  await input.fill(code);
  await clickByRoleText(page, /next|verify|continue/i);
  await settle(page, 5000);
  await screenshot(page, "totp-submitted");
  return true;
}

async function readTotpFromEe2fa(context, email) {
  const page = await context.newPage();
  try {
    await page.goto(EE2FA_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page, 2500);

    let card = page.locator(".account-card").filter({ hasText: email }).first();
    if (!(await card.isVisible({ timeout: 3000 }).catch(() => false))) {
      await page.locator("#search-input").fill(email).catch(() => {});
      await settle(page, 1000);
      card = page.locator(".account-card").filter({ hasText: email }).first();
    }

    if (!(await card.isVisible({ timeout: 4000 }).catch(() => false))) {
      await screenshot(page, "ee2fa-target-not-found");
      const emails = await page.locator(".account-email").evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())).catch(() => []);
      throw new Error(`No ee2fa card found for ${email}. Visible emails: ${emails.join(", ")}`);
    }

    for (let i = 0; i < 40; i += 1) {
      const token = await readToken(card);
      const seconds = await readSeconds(card);
      if (/^\d{6}$/.test(token) && seconds >= 8) {
        return token;
      }
      await page.waitForTimeout(1000);
    }

    const token = await readToken(card);
    if (!/^\d{6}$/.test(token)) {
      throw new Error("Could not read a 6-digit code from ee2fa.");
    }
    return token;
  } finally {
    await page.close().catch(() => {});
  }
}

async function confirmsTargetAccount(page, username) {
  await page.goto("https://myaccount.google.com/email", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await settle(page, 3500);
  return (await visibleText(page)).includes(username);
}

async function failFastForBlockingMessages(page) {
  const text = await visibleText(page);
  if (/wrong password|couldn.t sign you in|this browser or app may not be secure|captcha/i.test(text)) {
    throw new Error(`Google sign-in blocked/rejected: ${text.slice(0, 500)}`);
  }
}

async function dismissOptionalPrompts(page) {
  for (const name of [/not now/i, /skip/i, /cancel/i]) {
    await clickByRoleText(page, name).catch(() => {});
  }
}

async function clickByRoleText(page, pattern) {
  const button = page.getByRole("button", { name: pattern }).first();
  if (await button.isVisible({ timeout: 2500 }).catch(() => false)) {
    await button.click();
    await settle(page, 1800);
    return true;
  }

  const text = page.getByText(pattern).first();
  if (await text.isVisible({ timeout: 1500 }).catch(() => false)) {
    await text.click();
    await settle(page, 1800);
    return true;
  }

  return false;
}

async function readToken(card) {
  return (await card.locator(".otp-token").innerText().catch(() => "")).replace(/\D/g, "");
}

async function readSeconds(card) {
  const text = await card.locator(".timer-seconds").innerText().catch(() => "");
  return Number((text.match(/\d+/) || [0])[0]);
}

async function visibleText(page) {
  return (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ");
}

async function settle(page, ms = 1500) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(ms);
}

async function screenshot(page, name) {
  const file = path.join(ARTIFACT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`[google-auth] screenshot ${name}: ${file}`);
  return file;
}

function profileNameFor(username) {
  return `google-agent-${String(username || "default").toLowerCase().replace(/[^a-z0-9.-]+/g, "_")}`;
}
