// Hardcoded for this private device. The vault server lives on the Hermes VPS.
const VAULT_BASE = "https://social.149.28.133.149.sslip.io";
const API_TOKEN = "0ba62091f87961f3bc911d461e07aa811ae098fd649050151535ace5a6bda57c";

const activeTabEl = document.getElementById("activeTab");
const storeBtn = document.getElementById("storeBtn");
const outputEl = document.getElementById("output");
const statusDotEl = document.getElementById("statusDot");
const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(kind, message) {
  statusDotEl.className = `dot ${kind || ""}`;
  outputEl.textContent = message;
}

function normalizeOrigin(url) {
  return new URL(url).origin;
}

async function refreshActiveTab() {
  const tab = await getActiveTab();
  activeTabEl.textContent = tab?.url ? new URL(tab.url).hostname : "No active tab";
  return tab;
}

// One action: push the live session cookies AND (if entered) the login to the vault.
async function storeAll() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url || !tab.url.startsWith("http")) {
    throw new Error("Open a logged-in website tab first.");
  }
  const tabUrl = new URL(tab.url);
  const username = usernameEl.value.trim();
  const password = passwordEl.value;

  // 1) Capture cookies + storage via the service worker.
  const capture = await chrome.runtime.sendMessage({
    type: "CAPTURE_ACTIVE_TAB",
    tabId: tab.id,
    tabUrl: tab.url,
    origin: normalizeOrigin(tab.url),
    includeSessionStorage: true,
    vaultUrl: `${VAULT_BASE}/capture`,
    apiToken: API_TOKEN
  });
  if (!capture?.ok) throw new Error(capture?.error || "Cookie capture failed.");

  // 2) If username + password were entered, store the credential too.
  let credentialSaved = false;
  if (username && password) {
    const res = await fetch(`${VAULT_BASE}/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ hostname: tabUrl.hostname, origin: tabUrl.origin, username, password })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || `Saving login failed (HTTP ${res.status}).`);
    credentialSaved = true;
    passwordEl.value = "";
  }

  return {
    site: tabUrl.hostname,
    cookiesStored: capture.saved?.cookieCount ?? 0,
    captureId: capture.saved?.id,
    loginStored: credentialSaved,
    username: credentialSaved ? username : undefined
  };
}

storeBtn.addEventListener("click", async () => {
  storeBtn.disabled = true;
  setStatus("", "Storing to Hermes VPS vault...");
  try {
    const result = await storeAll();
    const lines = [
      `✓ Stored to Hermes vault`,
      `Site:    ${result.site}`,
      `Cookies: ${result.cookiesStored} captured`,
      `Login:   ${result.loginStored ? `saved (${result.username})` : "not entered — cookies only"}`
    ];
    setStatus("ok", lines.join("\n"));
  } catch (error) {
    setStatus("fail", error.message);
  } finally {
    storeBtn.disabled = false;
  }
});

refreshActiveTab()
  .then(() => setStatus("", "Ready. Enter login (optional) and store."))
  .catch((error) => setStatus("fail", error.message));
