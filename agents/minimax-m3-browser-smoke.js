const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { minimaxChat, imageFileToDataUrl, getMessageText } = require("../lib/minimax-native");

const ROOT = path.resolve(__dirname, "..");
const RUN_DIR = path.join(ROOT, "vault-data", "agent-runs", "minimax-m3-browser-smoke");

main().catch((error) => {
  console.error(`[m3-browser] FAILED: ${error.message}`);
  process.exit(1);
});

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });

  await testTextCall();

  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });

  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <title>MiniMax M3 Browser Control Smoke</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; background: #f5f7fb; color: #172033; }
            .panel { max-width: 640px; margin: 0 auto; padding: 28px; border: 1px solid #d6dbe5; border-radius: 8px; background: white; }
            h1 { margin-top: 0; }
            button { margin-right: 16px; padding: 14px 18px; border: 0; border-radius: 6px; font-weight: 700; cursor: pointer; }
            #blue { color: white; background: #1d4ed8; }
            #gray { color: #172033; background: #d8dee9; }
            #result { margin-top: 24px; min-height: 28px; font-size: 20px; font-weight: 700; }
          </style>
        </head>
        <body>
          <div class="panel">
            <h1>Browser Control Test</h1>
            <p>Instruction: click the blue button, not the gray button.</p>
            <button id="blue" onclick="document.getElementById('result').textContent='BLUE_CLICKED'">Blue Button</button>
            <button id="gray" onclick="document.getElementById('result').textContent='GRAY_CLICKED'">Gray Button</button>
            <div id="result"></div>
          </div>
        </body>
      </html>
    `);

    const screenshotPath = path.join(RUN_DIR, `${Date.now()}_page.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const decision = await askM3ForClickDecision(screenshotPath);
    console.log(`[m3-browser] model decision: ${JSON.stringify(decision)}`);

    if (decision.action !== "click" || !["blue", "gray"].includes(decision.target)) {
      throw new Error(`Unexpected model decision: ${JSON.stringify(decision)}`);
    }

    await page.locator(`#${decision.target}`).click();
    const result = await page.locator("#result").textContent();
    if (result !== "BLUE_CLICKED") {
      throw new Error(`Browser control failed. Result was ${result}`);
    }

    console.log("[m3-browser] VALIDATED: MiniMax-M3 native vision chose the correct UI action and Playwright executed it.");
  } finally {
    await browser.close();
  }
}

async function testTextCall() {
  const payload = await minimaxChat({
    messages: [
      { role: "user", content: "Reply with exactly M3_NATIVE_OK" }
    ],
    maxCompletionTokens: 32
  });
  const text = getMessageText(payload).trim();
  if (text !== "M3_NATIVE_OK") {
    throw new Error(`MiniMax-M3 native text check failed: ${text}`);
  }
  console.log("[m3-browser] MiniMax-M3 native text call ok");
}

async function askM3ForClickDecision(screenshotPath) {
  const payload = await minimaxChat({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "You control a browser through Playwright.",
              "Look at the screenshot and choose the correct button.",
              "Instruction: click the blue button, not the gray button.",
              "Return ONLY compact JSON with this schema: {\"action\":\"click\",\"target\":\"blue\"}."
            ].join("\n")
          },
          {
            type: "image_url",
            image_url: {
              url: imageFileToDataUrl(screenshotPath),
              detail: "low"
            }
          }
        ]
      }
    ],
    maxCompletionTokens: 128
  });

  const text = getMessageText(payload).trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`MiniMax-M3 did not return JSON: ${text}`);
  }
  return JSON.parse(match[0]);
}
