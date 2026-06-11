const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_MODEL = "MiniMax-M3";
const HERMES_VAULT = "C:\\Users\\Eternalgy\\.hermes\\vault.json";

function getMiniMaxApiKey() {
  if (process.env.MINIMAX_M3_KEY) {
    return process.env.MINIMAX_M3_KEY;
  }

  if (process.env.MINIMAX_API_KEY) {
    return process.env.MINIMAX_API_KEY;
  }

  if (fs.existsSync(HERMES_VAULT)) {
    const vault = JSON.parse(fs.readFileSync(HERMES_VAULT, "utf8"));
    const credential = (vault.credentials || []).find((item) => item.id === "Minimax Token Plan");
    if (credential?.credential && typeof credential.credential === "string") {
      return credential.credential;
    }
    if (credential?.credential?.api_key) {
      return credential.credential.api_key;
    }
    if (credential?.credential?.apiKey) {
      return credential.credential.apiKey;
    }
  }

  throw new Error("MiniMax API key not found. Set MINIMAX_M3_KEY, MINIMAX_API_KEY, or add Hermes credential id 'Minimax Token Plan'.");
}

async function minimaxChat({ messages, tools, model = DEFAULT_MODEL, temperature = 0, maxCompletionTokens = 1024 }) {
  const apiKey = getMiniMaxApiKey();
  const body = {
    model,
    messages,
    thinking: { type: "adaptive" },
    temperature,
    max_completion_tokens: maxCompletionTokens,
    stream: false
  };

  if (tools) {
    body.tools = tools;
  }

  const response = await fetch(`${process.env.MINIMAX_BASE_URL || DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`MiniMax API HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  return payload;
}

function imageFileToDataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg"
    ? "image/jpeg"
    : ext === ".webp"
      ? "image/webp"
      : ext === ".gif"
        ? "image/gif"
        : "image/png";
  const data = fs.readFileSync(file).toString("base64");
  return `data:${mime};base64,${data}`;
}

function getMessageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((part) => part.text || "").join("");
  }
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

module.exports = {
  minimaxChat,
  imageFileToDataUrl,
  getMessageText
};
