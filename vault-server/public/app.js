// Single-page admin UI for the vault server.
// Auth model: the admin token is held client-side and sent as a Bearer header
// on every API call (matches what the extension and agents use).

const TOKEN_KEY = "ee_vault_token";
let token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";

const $ = (id) => document.getElementById(id);

async function api(method, route, body) {
  const res = await fetch(route, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* artifact or empty */ }
  if (res.status === 401) { lock(); throw new Error("Unauthorized"); }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

function toast(msg, kind) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${kind || ""}`;
  setTimeout(() => el.classList.add("hidden"), 2600);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Auth gating -----------------------------------------------------------

function unlock() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  loadCaptures();
}

function lock() {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  token = $("tokenInput").value.trim();
  if (!token) return;
  try {
    await api("GET", "/auth/check");
    const store = $("remember").checked ? localStorage : sessionStorage;
    store.setItem(TOKEN_KEY, token);
    unlock();
  } catch {
    $("loginError").textContent = "Invalid token.";
  }
});

$("logout").addEventListener("click", lock);

// --- Tabs ------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.add("hidden"));
    $(`tab-${btn.dataset.tab}`).classList.remove("hidden");
    if (btn.dataset.tab === "captures") loadCaptures();
    if (btn.dataset.tab === "credentials") loadCredentials();
  });
});

// --- Captures --------------------------------------------------------------

async function loadCaptures() {
  const list = $("capturesList");
  list.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const { captures } = await api("GET", "/captures");
    if (!captures.length) { list.innerHTML = `<p class="muted">No captures yet. Use the laptop extension to push one.</p>`; return; }
    list.innerHTML = captures.map((c) => `
      <div class="card">
        <div class="grow">
          <div class="host">${escapeHtml(c.hostname)}</div>
          <div class="sub">${escapeHtml(c.capturedAt)} · ${escapeHtml(c.url || "")}</div>
        </div>
        <span class="pill">${c.cookieCount} cookies</span>
        <button class="danger" data-del-capture="${escapeHtml(c.id)}">Delete</button>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
}

$("refreshCaptures").addEventListener("click", loadCaptures);

// --- Credentials -----------------------------------------------------------

async function loadCredentials() {
  const list = $("credsList");
  list.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const { credentials } = await api("GET", "/credentials");
    if (!credentials.length) { list.innerHTML = `<p class="muted">No saved logins yet.</p>`; return; }
    list.innerHTML = credentials.map((c) => `
      <div class="card">
        <div class="grow">
          <div class="host">${escapeHtml(c.hostname)}</div>
          <div class="sub">${escapeHtml(c.username)} · saved ${escapeHtml(c.savedAt)}</div>
        </div>
        <button class="danger" data-del-cred="${escapeHtml(c.id)}">Delete</button>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
}

$("refreshCreds").addEventListener("click", loadCredentials);

$("credForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const hostname = $("credHost").value.trim();
  const username = $("credUser").value.trim();
  const password = $("credPass").value;
  if (!hostname || !username || !password) return toast("All fields required", "bad");
  try {
    await api("POST", "/credential", { hostname, username, password });
    $("credPass").value = "";
    toast("Login saved", "ok");
    loadCredentials();
  } catch (e2) {
    toast(e2.message, "bad");
  }
});

// Delegated delete handlers for both lists.
document.addEventListener("click", async (e) => {
  const capId = e.target.getAttribute?.("data-del-capture");
  const credId = e.target.getAttribute?.("data-del-cred");
  if (capId && confirm("Delete this capture?")) {
    try { await api("DELETE", `/capture/${encodeURIComponent(capId)}`); toast("Deleted", "ok"); loadCaptures(); }
    catch (err) { toast(err.message, "bad"); }
  }
  if (credId && confirm("Delete this login?")) {
    try { await api("DELETE", `/credential/${encodeURIComponent(credId)}`); toast("Deleted", "ok"); loadCredentials(); }
    catch (err) { toast(err.message, "bad"); }
  }
});

// --- Post ------------------------------------------------------------------

$("postForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const platform = $("postPlatform").value;
  const postText = $("postText").value.trim() || "Hello world";
  const btn = $("postRun");
  btn.disabled = true;
  $("postLog").textContent = "Running agent… this can take a minute.";
  $("postShots").innerHTML = "";
  try {
    const res = await api("POST", `/post/${platform}`, { postText });
    $("postLog").textContent = res.log || "(no output)";
    renderShots(res.artifacts || []);
    toast(res.ok ? "Post agent finished" : `Agent exited ${res.exitCode}`, res.ok ? "ok" : "bad");
  } catch (err) {
    $("postLog").textContent = err.message;
    toast(err.message, "bad");
  } finally {
    btn.disabled = false;
  }
});

function renderShots(artifacts) {
  // The artifact endpoint requires a Bearer header, so plain <img src> would 401.
  // Fetch each shot as an authorized blob and swap in an object URL.
  $("postShots").innerHTML = artifacts.map((a) =>
    `<img data-file="${escapeHtml(a.file)}" alt="${escapeHtml(a.file)}" />`).join("");
  document.querySelectorAll("#postShots img").forEach(async (img) => {
    const file = img.getAttribute("data-file");
    try {
      const res = await fetch(`/artifact/${encodeURIComponent(file)}`, { headers: { Authorization: `Bearer ${token}` } });
      img.src = URL.createObjectURL(await res.blob());
    } catch { /* leave broken */ }
  });
}

// --- Boot ------------------------------------------------------------------

(async function boot() {
  if (!token) return;
  try { await api("GET", "/auth/check"); unlock(); } catch { lock(); }
})();
