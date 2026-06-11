const DEFAULT_COOKIE_DOMAINS = [
  ".linkedin.com",
  ".twitter.com",
  ".x.com",
  ".facebook.com",
  ".instagram.com",
  ".threads.net",
  ".youtube.com",
  ".google.com",
  ".tiktok.com",
  ".bsky.app",
  ".mastodon.social",
  "web.telegram.org",
  "web.whatsapp.com"
];

function authHeaders(apiToken, extra = {}) {
  const headers = { ...extra };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  return headers;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["CAPTURE_ACTIVE_TAB", "RESTORE_LATEST_FOR_TAB", "FILL_CREDENTIAL_FOR_TAB"].includes(message?.type)) {
    return false;
  }

  const task = message.type === "CAPTURE_ACTIVE_TAB"
    ? captureActiveTab(message).then((saved) => ({ saved }))
    : message.type === "RESTORE_LATEST_FOR_TAB"
      ? restoreLatestForTab(message).then((restored) => ({ restored }))
      : fillCredentialForTab(message).then((filled) => ({ filled }));

  task
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function captureActiveTab(message) {
  const tabUrl = new URL(message.tabUrl);
  const storage = await capturePageStorage(message.tabId, message.includeSessionStorage);
  const cookies = await captureCookies(tabUrl.hostname);

  const bundle = {
    capturedAt: new Date().toISOString(),
    page: {
      url: message.tabUrl,
      origin: message.origin,
      hostname: tabUrl.hostname,
      title: storage.title
    },
    browser: {
      userAgent: storage.userAgent,
      language: storage.language,
      platform: storage.platform
    },
    cookies,
    localStorage: storage.localStorage,
    sessionStorage: storage.sessionStorage,
    indexedDB: storage.indexedDB,
    notes: [
      "This bundle contains sensitive authenticated browser state.",
      "Store encrypted, never paste into model context, and delete when no longer needed."
    ]
  };

  const response = await fetch(message.vaultUrl, {
    method: "POST",
    headers: authHeaders(message.apiToken, { "Content-Type": "application/json" }),
    body: JSON.stringify(bundle)
  });

  if (!response.ok) {
    throw new Error(`Vault server returned HTTP ${response.status}`);
  }

  return response.json();
}

async function fillCredentialForTab(message) {
  const credentialResponse = await fetch(`${message.vaultBaseUrl}/credential?hostname=${encodeURIComponent(message.hostname)}`, {
    headers: authHeaders(message.apiToken)
  });
  const credentialPayload = await credentialResponse.json();
  if (!credentialResponse.ok || !credentialPayload.ok) {
    throw new Error(credentialPayload.error || `Vault credential returned HTTP ${credentialResponse.status}`);
  }

  const credential = credentialPayload.credential;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: message.tabId },
    func: ({ username, password }) => {
      const userSelectors = [
        'input[autocomplete="username"]',
        'input[type="email"]',
        'input[name*="email" i]',
        'input[name*="user" i]',
        'input[id*="email" i]',
        'input[id*="user" i]',
        'input[type="text"]'
      ];
      const passwordSelectors = [
        'input[autocomplete="current-password"]',
        'input[type="password"]'
      ];

      function firstVisible(selectors) {
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          const node = nodes.find((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          });
          if (node) return node;
        }
        return null;
      }

      function setValue(input, value) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        descriptor.set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const userInput = firstVisible(userSelectors);
      const passwordInput = firstVisible(passwordSelectors);

      if (userInput) setValue(userInput, username);
      if (passwordInput) setValue(passwordInput, password);

      return {
        usernameFieldFound: Boolean(userInput),
        passwordFieldFound: Boolean(passwordInput),
        title: document.title
      };
    },
    args: [{ username: credential.username, password: credential.password }]
  });

  return {
    hostname: credential.hostname,
    username: credential.username,
    ...result.result
  };
}

async function restoreLatestForTab(message) {
  const capturesUrl = `${message.vaultBaseUrl}/captures?hostname=${encodeURIComponent(message.hostname)}`;
  const listResponse = await fetch(capturesUrl, { headers: authHeaders(message.apiToken) });
  if (!listResponse.ok) {
    throw new Error(`Vault list returned HTTP ${listResponse.status}`);
  }

  const listPayload = await listResponse.json();
  const [latest] = listPayload.captures || [];
  if (!latest) {
    throw new Error(`No capture found for ${message.hostname}`);
  }

  const captureResponse = await fetch(`${message.vaultBaseUrl}/capture/${encodeURIComponent(latest.id)}`, {
    headers: authHeaders(message.apiToken)
  });
  if (!captureResponse.ok) {
    throw new Error(`Vault capture returned HTTP ${captureResponse.status}`);
  }

  const capturePayload = await captureResponse.json();
  const capture = capturePayload.capture;
  const activeCookieStore = await getCookieStoreForTab(message.tabId);
  const cookieResults = await restoreCookies(capture.cookies || [], activeCookieStore?.id);
  await restorePageStorage(message.tabId, capture.localStorage || {}, capture.sessionStorage || {});
  await chrome.tabs.reload(message.tabId);

  return {
    captureId: latest.id,
    hostname: latest.hostname,
    cookieStoreId: activeCookieStore?.id || null,
    cookiesAttempted: cookieResults.attempted,
    cookiesSet: cookieResults.set,
    cookiesFailed: cookieResults.failed,
    localStorageKeys: Object.keys(capture.localStorage || {}),
    sessionStorageKeys: Object.keys(capture.sessionStorage || {}),
    reloaded: true
  };
}

async function getCookieStoreForTab(tabId) {
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((store) => store.tabIds.includes(tabId)) || null;
}

async function restoreCookies(cookies, storeId) {
  let set = 0;
  let failed = 0;

  for (const cookie of cookies) {
    try {
      const secure = Boolean(cookie.secure);
      const protocol = secure ? "https:" : "http:";
      const domain = String(cookie.domain || "").replace(/^\./, "");
      const url = `${protocol}//${domain}${cookie.path || "/"}`;
      const details = {
        url,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || "/",
        secure,
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: normalizeSameSite(cookie.sameSite)
      };

      if (storeId) {
        details.storeId = storeId;
      }

      if (cookie.domain && cookie.domain.startsWith(".")) {
        details.domain = cookie.domain;
      }

      if (!cookie.session && typeof cookie.expirationDate === "number") {
        details.expirationDate = cookie.expirationDate;
      }

      await chrome.cookies.set(details);
      set += 1;
    } catch (error) {
      failed += 1;
      console.warn("Cookie restore failed", cookie?.domain, cookie?.name, error);
    }
  }

  return { attempted: cookies.length, set, failed };
}

function normalizeSameSite(value) {
  if (["no_restriction", "lax", "strict"].includes(value)) {
    return value;
  }
  return "unspecified";
}

async function restorePageStorage(tabId, localStorageData, sessionStorageData) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: ({ localStorageData: ls, sessionStorageData: ss }) => {
      for (const [key, value] of Object.entries(ls || {})) {
        window.localStorage.setItem(key, value);
      }
      for (const [key, value] of Object.entries(ss || {})) {
        window.sessionStorage.setItem(key, value);
      }
      return {
        localStorageKeys: Object.keys(ls || {}),
        sessionStorageKeys: Object.keys(ss || {})
      };
    },
    args: [{ localStorageData, sessionStorageData }]
  });
}

async function capturePageStorage(tabId, includeSessionStorage) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (shouldIncludeSessionStorage) => {
      function dumpStorage(storage) {
        const out = {};
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          out[key] = storage.getItem(key);
        }
        return out;
      }

      return {
        title: document.title,
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        localStorage: dumpStorage(window.localStorage),
        sessionStorage: shouldIncludeSessionStorage ? dumpStorage(window.sessionStorage) : {},
        indexedDB: {
          databaseNamesSupported: Boolean(indexedDB?.databases),
          databaseNames: indexedDB?.databases ? null : []
        }
      };
    },
    args: [includeSessionStorage]
  });

  const value = result?.result;
  if (!value) {
    throw new Error("Could not read page storage from active tab.");
  }

  if (value.indexedDB.databaseNamesSupported) {
    try {
      const [dbResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const databases = await indexedDB.databases();
          return databases.map((db) => ({ name: db.name, version: db.version }));
        }
      });
      value.indexedDB.databaseNames = dbResult?.result || [];
    } catch (error) {
      value.indexedDB.error = error.message;
    }
  }

  return value;
}

async function captureCookies(hostname) {
  const domains = domainsForHost(hostname);
  const all = [];
  const seen = new Set();

  for (const domain of domains) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const cookie of cookies) {
      const key = `${cookie.storeId}:${cookie.domain}:${cookie.path}:${cookie.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(cookie);
      }
    }
  }

  return all.sort((a, b) => `${a.domain}${a.path}${a.name}`.localeCompare(`${b.domain}${b.path}${b.name}`));
}

function domainsForHost(hostname) {
  const matchingDefaults = DEFAULT_COOKIE_DOMAINS.filter((domain) => {
    const bare = domain.replace(/^\./, "");
    return hostname === bare || hostname.endsWith(`.${bare}`);
  });

  const parts = hostname.split(".");
  const candidates = new Set([hostname, `.${hostname}`, ...matchingDefaults]);

  for (let i = 0; i < parts.length - 1; i += 1) {
    const parent = parts.slice(i).join(".");
    candidates.add(parent);
    candidates.add(`.${parent}`);
  }

  return Array.from(candidates);
}
