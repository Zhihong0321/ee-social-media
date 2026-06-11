const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.VAULT_PORT || 47321);
const HOST = process.env.VAULT_HOST || "127.0.0.1";
const ROOT = path.resolve(__dirname, "..");
const VAULT_DIR = path.join(ROOT, "vault-data");
const CAPTURE_DIR = path.join(VAULT_DIR, "captures");
const CREDENTIAL_DIR = path.join(VAULT_DIR, "credentials");
const RUNS_DIR = path.join(VAULT_DIR, "agent-runs");
const KEY_FILE = path.join(VAULT_DIR, ".vault-key");
const SECRET_FILE = path.join(VAULT_DIR, ".secret");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(CAPTURE_DIR, { recursive: true });
fs.mkdirSync(CREDENTIAL_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });

const key = loadOrCreateKey();
const SECRET = loadOrCreateSecret();

// Map a platform name to the agent script that posts to it.
const AGENTS = {
  facebook: path.join(ROOT, "agents", "facebook-hello-world.js")
};

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;

  // --- Public routes (no auth): health + the UI shell itself. ---
  if (req.method === "GET" && route === "/health") {
    writeJson(res, 200, { ok: true, vaultDir: VAULT_DIR });
    return;
  }

  if (req.method === "GET" && isStaticRoute(route)) {
    return serveStatic(res, route);
  }

  // --- Everything below requires the admin token. ---
  if (!isAuthorized(req)) {
    writeJson(res, 401, { ok: false, error: "Unauthorized. Provide a valid admin token." });
    return;
  }

  // Lets the UI verify a pasted token before storing it.
  if (req.method === "GET" && route === "/auth/check") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && route === "/captures") {
    try {
      writeJson(res, 200, { ok: true, captures: listCaptures(url.searchParams.get("hostname")) });
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && route.startsWith("/capture/")) {
    try {
      const id = decodeURIComponent(route.replace("/capture/", ""));
      writeJson(res, 200, { ok: true, capture: loadBundle(id) });
    } catch (error) {
      writeJson(res, 404, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "DELETE" && route.startsWith("/capture/")) {
    try {
      const id = decodeURIComponent(route.replace("/capture/", ""));
      writeJson(res, 200, deleteCapture(id));
    } catch (error) {
      writeJson(res, 404, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && route === "/capture") {
    try {
      const body = await readBody(req, 25 * 1024 * 1024);
      writeJson(res, 200, saveBundle(JSON.parse(body)));
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && route === "/credentials") {
    writeJson(res, 200, { ok: true, credentials: listCredentials() });
    return;
  }

  if (req.method === "POST" && route === "/credential") {
    try {
      const body = await readBody(req, 1024 * 1024);
      writeJson(res, 200, saveCredential(JSON.parse(body)));
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && route === "/credential") {
    try {
      const hostname = url.searchParams.get("hostname");
      if (!hostname) throw new Error("hostname is required");
      writeJson(res, 200, { ok: true, credential: loadCredentialForHost(hostname) });
    } catch (error) {
      writeJson(res, 404, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "DELETE" && route.startsWith("/credential/")) {
    try {
      const host = decodeURIComponent(route.replace("/credential/", ""));
      writeJson(res, 200, deleteCredential(host));
    } catch (error) {
      writeJson(res, 404, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && route.startsWith("/post/")) {
    const platform = route.replace("/post/", "").toLowerCase();
    try {
      const body = await readBody(req, 1024 * 1024).catch(() => "{}");
      const options = body ? JSON.parse(body) : {};
      const result = await runAgent(platform, options);
      writeJson(res, result.ok ? 200 : 500, result);
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && route === "/runs") {
    writeJson(res, 200, { ok: true, runs: listRunArtifacts(url.searchParams.get("platform")) });
    return;
  }

  if (req.method === "GET" && route.startsWith("/artifact/")) {
    return serveArtifact(res, decodeURIComponent(route.replace("/artifact/", "")));
  }

  writeJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Vault server listening on http://${HOST}:${PORT}`);
  console.log(`Captures will be written under ${CAPTURE_DIR}`);
  console.log(`Admin token loaded (${SECRET.length} chars). Keep it secret.`);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isAuthorized(req) {
  const header = req.headers["authorization"] || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return timingSafeEqualStr(match[1].trim(), SECRET);
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function loadOrCreateSecret() {
  if (process.env.VAULT_SECRET) return process.env.VAULT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, "utf8").trim();
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  console.log(`Generated new admin token and saved it to ${SECRET_FILE}`);
  return generated;
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

function saveBundle(bundle) {
  const capturedAt = bundle.capturedAt || new Date().toISOString();
  const hostname = sanitize(bundle.page?.hostname || "unknown-host");
  const stamp = capturedAt.replace(/[:.]/g, "-");
  const id = `${stamp}_${hostname}_${crypto.randomBytes(4).toString("hex")}`;
  const encrypted = encryptJson(bundle);
  const encryptedPath = path.join(CAPTURE_DIR, `${id}.json.enc`);
  const metaPath = path.join(CAPTURE_DIR, `${id}.meta.json`);

  fs.writeFileSync(encryptedPath, JSON.stringify(encrypted, null, 2));
  fs.writeFileSync(metaPath, JSON.stringify({
    id,
    capturedAt,
    hostname,
    origin: bundle.page?.origin,
    url: bundle.page?.url,
    cookieCount: Array.isArray(bundle.cookies) ? bundle.cookies.length : 0,
    localStorageKeys: Object.keys(bundle.localStorage || {}),
    sessionStorageKeys: Object.keys(bundle.sessionStorage || {}),
    encryptedFile: path.basename(encryptedPath)
  }, null, 2));

  return {
    ok: true,
    id,
    hostname,
    cookieCount: Array.isArray(bundle.cookies) ? bundle.cookies.length : 0,
    encryptedFile: encryptedPath,
    metaFile: metaPath
  };
}

function deleteCapture(id) {
  if (!/^[a-z0-9_.:-]+$/i.test(id)) throw new Error("Invalid capture id");
  const encryptedPath = path.join(CAPTURE_DIR, `${id}.json.enc`);
  const metaPath = path.join(CAPTURE_DIR, `${id}.meta.json`);
  if (!fs.existsSync(metaPath) && !fs.existsSync(encryptedPath)) {
    throw new Error("Capture not found");
  }
  fs.rmSync(encryptedPath, { force: true });
  fs.rmSync(metaPath, { force: true });
  return { ok: true, id, deleted: true };
}

function listCaptures(hostname) {
  if (!fs.existsSync(CAPTURE_DIR)) return [];
  const normalizedHost = hostname ? String(hostname).toLowerCase() : null;
  return fs.readdirSync(CAPTURE_DIR)
    .filter((name) => name.endsWith(".meta.json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, name), "utf8")))
    .filter((meta) => {
      if (!normalizedHost) return true;
      const capturedHost = String(meta.hostname || "").toLowerCase();
      return normalizedHost === capturedHost ||
        normalizedHost.endsWith(`.${capturedHost}`) ||
        capturedHost.endsWith(`.${normalizedHost}`);
    })
    .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
}

function loadBundle(id) {
  if (!/^[a-z0-9_.:-]+$/i.test(id)) throw new Error("Invalid capture id");
  const encryptedPath = path.join(CAPTURE_DIR, `${id}.json.enc`);
  if (!fs.existsSync(encryptedPath)) throw new Error("Capture not found");
  return decryptJson(JSON.parse(fs.readFileSync(encryptedPath, "utf8")));
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function saveCredential(credential) {
  if (!credential || typeof credential !== "object") {
    throw new Error("Credential payload is required");
  }
  if (!credential.hostname || !credential.username || !credential.password) {
    throw new Error("hostname, username, and password are required");
  }

  const hostname = sanitizeHost(credential.hostname);
  const id = hostname;
  const encryptedPath = path.join(CREDENTIAL_DIR, `${id}.json.enc`);
  const metaPath = path.join(CREDENTIAL_DIR, `${id}.meta.json`);
  const now = new Date().toISOString();
  const payload = {
    savedAt: now,
    hostname: String(credential.hostname).toLowerCase(),
    origin: credential.origin || null,
    username: credential.username,
    password: credential.password,
    notes: credential.notes || "Saved via vault UI or extension."
  };

  fs.writeFileSync(encryptedPath, JSON.stringify(encryptJson(payload), null, 2));
  fs.writeFileSync(metaPath, JSON.stringify({
    id,
    savedAt: now,
    hostname: payload.hostname,
    origin: payload.origin,
    username: payload.username,
    encryptedFile: path.basename(encryptedPath)
  }, null, 2));

  return { ok: true, id, hostname: payload.hostname, username: payload.username, metaFile: metaPath };
}

function listCredentials() {
  if (!fs.existsSync(CREDENTIAL_DIR)) return [];
  return fs.readdirSync(CREDENTIAL_DIR)
    .filter((name) => name.endsWith(".meta.json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(CREDENTIAL_DIR, name), "utf8")))
    .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
}

function loadCredentialForHost(hostname) {
  for (const candidate of credentialCandidates(hostname)) {
    const encryptedPath = path.join(CREDENTIAL_DIR, `${candidate}.json.enc`);
    if (fs.existsSync(encryptedPath)) {
      return decryptJson(JSON.parse(fs.readFileSync(encryptedPath, "utf8")));
    }
  }
  throw new Error(`No credential found for ${hostname}`);
}

function deleteCredential(host) {
  const id = sanitizeHost(host);
  const encryptedPath = path.join(CREDENTIAL_DIR, `${id}.json.enc`);
  const metaPath = path.join(CREDENTIAL_DIR, `${id}.meta.json`);
  if (!fs.existsSync(metaPath) && !fs.existsSync(encryptedPath)) {
    throw new Error("Credential not found");
  }
  fs.rmSync(encryptedPath, { force: true });
  fs.rmSync(metaPath, { force: true });
  return { ok: true, id, deleted: true };
}

function credentialCandidates(hostname) {
  const parts = String(hostname).toLowerCase().split(".");
  const candidates = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    candidates.push(sanitizeHost(parts.slice(i).join(".")));
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Posting agents
// ---------------------------------------------------------------------------

function runAgent(platform, options) {
  const script = AGENTS[platform];
  if (!script) {
    return Promise.resolve({ ok: false, error: `Unknown platform "${platform}". Known: ${Object.keys(AGENTS).join(", ")}` });
  }
  if (!fs.existsSync(script)) {
    return Promise.resolve({ ok: false, error: `Agent script missing: ${script}` });
  }

  return new Promise((resolve) => {
    const env = { ...process.env };
    if (options.postText) env.POST_TEXT = String(options.postText);
    if (options.headless != null) env.HEADLESS = options.headless ? "1" : "0";

    // xvfb-run gives the headed browser a virtual display on a GUI-less VPS.
    const useXvfb = process.platform === "linux" && process.env.USE_XVFB !== "0";
    const command = useXvfb ? "xvfb-run" : "node";
    const args = useXvfb ? ["-a", "node", script] : [script];

    const child = spawn(command, args, { cwd: ROOT, env });
    let out = "";
    const cap = (chunk) => { out += chunk.toString(); if (out.length > 200000) out = out.slice(-200000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);

    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, platform, error: error.message, log: out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        platform,
        exitCode: code,
        log: out.slice(-12000),
        artifacts: listRunArtifacts(platform).slice(0, 8)
      });
    });
  });
}

function listRunArtifacts(platform) {
  const base = platform ? path.join(RUNS_DIR, sanitize(platform)) : RUNS_DIR;
  if (!fs.existsSync(base)) return [];
  const dirs = platform ? [base] : fs.readdirSync(base).map((d) => path.join(base, d)).filter((p) => safeIsDir(p));
  const artifacts = [];
  for (const dir of dirs) {
    if (!safeIsDir(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".png")) continue;
      const rel = path.relative(RUNS_DIR, path.join(dir, file)).split(path.sep).join("/");
      artifacts.push({ file: rel, mtime: fs.statSync(path.join(dir, file)).mtimeMs });
    }
  }
  return artifacts.sort((a, b) => b.mtime - a.mtime);
}

function serveArtifact(res, rel) {
  // Only allow png files inside the runs dir; block path traversal.
  const target = path.resolve(RUNS_DIR, rel);
  if (!target.startsWith(RUNS_DIR + path.sep) || !target.endsWith(".png") || !fs.existsSync(target)) {
    writeJson(res, 404, { ok: false, error: "Artifact not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": "image/png" });
  fs.createReadStream(target).pipe(res);
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Static UI
// ---------------------------------------------------------------------------

function isStaticRoute(route) {
  if (route === "/") return true;
  const file = path.join(PUBLIC_DIR, route);
  return file.startsWith(PUBLIC_DIR) && STATIC_TYPES[path.extname(route)] && fs.existsSync(file);
}

function serveStatic(res, route) {
  const rel = route === "/" ? "index.html" : route.replace(/^\//, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
    writeJson(res, 404, { ok: false, error: "Not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Crypto + helpers
// ---------------------------------------------------------------------------

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64")
  };
}

function decryptJson(payload) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function loadOrCreateKey() {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    return Buffer.from(fs.readFileSync(KEY_FILE, "utf8"), "base64");
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, generated.toString("base64"), { mode: 0o600 });
  return generated;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function setCors(res) {
  // Auth is via the Authorization header (not cookies), so a wildcard origin is safe here.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function writeJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function sanitize(value) {
  return String(value).replace(/[^a-z0-9_.-]/gi, "_").slice(0, 120);
}

function sanitizeHost(value) {
  return String(value).toLowerCase().replace(/^\./, "").replace(/[^a-z0-9.-]/g, "_").slice(0, 160);
}
