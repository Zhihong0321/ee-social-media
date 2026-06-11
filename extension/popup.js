const activeTabEl = document.getElementById("activeTab");
const captureBtn = document.getElementById("captureBtn");
const restoreBtn = document.getElementById("restoreBtn");
const saveCredentialBtn = document.getElementById("saveCredentialBtn");
const fillCredentialBtn = document.getElementById("fillCredentialBtn");
const outputEl = document.getElementById("output");
const vaultUrlEl = document.getElementById("vaultUrl");
const apiTokenEl = document.getElementById("apiToken");
const includeSessionStorageEl = document.getElementById("includeSessionStorage");
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
  const parsed = new URL(url);
  return parsed.origin;
}

async function saveSettings() {
  await chrome.storage.local.set({
    vaultUrl: vaultUrlEl.value.trim(),
    apiToken: apiTokenEl.value.trim(),
    includeSessionStorage: includeSessionStorageEl.checked
  });
}

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    vaultUrl: "https://social.149.28.133.149.sslip.io/capture",
    apiToken: "",
    includeSessionStorage: true
  });
  vaultUrlEl.value = settings.vaultUrl;
  apiTokenEl.value = settings.apiToken;
  includeSessionStorageEl.checked = settings.includeSessionStorage;
}

async function refreshActiveTab() {
  const tab = await getActiveTab();
  activeTabEl.textContent = tab?.url || "No active tab";
  return tab;
}

async function capture() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url || !tab.url.startsWith("http")) {
    throw new Error("Open a logged-in social website tab first.");
  }

  await saveSettings();

  const response = await chrome.runtime.sendMessage({
    type: "CAPTURE_ACTIVE_TAB",
    tabId: tab.id,
    tabUrl: tab.url,
    origin: normalizeOrigin(tab.url),
    includeSessionStorage: includeSessionStorageEl.checked,
    vaultUrl: vaultUrlEl.value.trim(),
    apiToken: apiTokenEl.value.trim()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Capture failed.");
  }

  return response;
}

async function restoreLatest() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url || !tab.url.startsWith("http")) {
    throw new Error("Open the target social website tab first.");
  }

  await saveSettings();

  const tabUrl = new URL(tab.url);
  const response = await chrome.runtime.sendMessage({
    type: "RESTORE_LATEST_FOR_TAB",
    tabId: tab.id,
    tabUrl: tab.url,
    hostname: tabUrl.hostname,
    vaultBaseUrl: vaultUrlEl.value.trim().replace(/\/capture$/, ""),
    apiToken: apiTokenEl.value.trim()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Restore failed.");
  }

  return response;
}

async function saveCredential() {
  const tab = await getActiveTab();
  if (!tab?.url || !tab.url.startsWith("http")) {
    throw new Error("Open the target website tab first.");
  }

  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) {
    throw new Error("Enter username and password in the popup first.");
  }

  await saveSettings();
  const tabUrl = new URL(tab.url);
  const vaultBaseUrl = vaultUrlEl.value.trim().replace(/\/capture$/, "");
  const response = await fetch(`${vaultBaseUrl}/credential`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiTokenEl.value.trim()}`
    },
    body: JSON.stringify({
      hostname: tabUrl.hostname,
      origin: tabUrl.origin,
      username,
      password
    })
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Vault returned HTTP ${response.status}`);
  }

  passwordEl.value = "";
  return payload;
}

async function fillCredential() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url || !tab.url.startsWith("http")) {
    throw new Error("Open the target login page first.");
  }

  await saveSettings();
  const tabUrl = new URL(tab.url);
  const response = await chrome.runtime.sendMessage({
    type: "FILL_CREDENTIAL_FOR_TAB",
    tabId: tab.id,
    hostname: tabUrl.hostname,
    vaultBaseUrl: vaultUrlEl.value.trim().replace(/\/capture$/, ""),
    apiToken: apiTokenEl.value.trim()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Fill failed.");
  }

  return response;
}

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  setStatus("", "Capturing...");
  try {
    const result = await capture();
    setStatus("ok", JSON.stringify(result.saved, null, 2));
  } catch (error) {
    setStatus("fail", error.message);
  } finally {
    captureBtn.disabled = false;
  }
});

restoreBtn.addEventListener("click", async () => {
  restoreBtn.disabled = true;
  setStatus("", "Restoring latest capture...");
  try {
    const result = await restoreLatest();
    setStatus("ok", JSON.stringify(result.restored, null, 2));
  } catch (error) {
    setStatus("fail", error.message);
  } finally {
    restoreBtn.disabled = false;
  }
});

saveCredentialBtn.addEventListener("click", async () => {
  saveCredentialBtn.disabled = true;
  setStatus("", "Saving credential...");
  try {
    const result = await saveCredential();
    setStatus("ok", JSON.stringify({
      ok: true,
      hostname: result.hostname,
      username: result.username
    }, null, 2));
  } catch (error) {
    setStatus("fail", error.message);
  } finally {
    saveCredentialBtn.disabled = false;
  }
});

fillCredentialBtn.addEventListener("click", async () => {
  fillCredentialBtn.disabled = true;
  setStatus("", "Filling saved credential...");
  try {
    const result = await fillCredential();
    setStatus("ok", JSON.stringify(result.filled, null, 2));
  } catch (error) {
    setStatus("fail", error.message);
  } finally {
    fillCredentialBtn.disabled = false;
  }
});

vaultUrlEl.addEventListener("change", saveSettings);
apiTokenEl.addEventListener("change", saveSettings);
includeSessionStorageEl.addEventListener("change", saveSettings);

loadSettings()
  .then(refreshActiveTab)
  .then(() => setStatus("", "Ready. Open a logged-in platform tab and capture."))
  .catch((error) => setStatus("fail", error.message));
