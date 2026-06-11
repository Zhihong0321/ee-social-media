const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120000,
  expect: {
    timeout: 10000
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "vault-data/playwright-report", open: "never" }]
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chrome",
      use: {
        channel: "chrome",
        headless: false
      }
    }
  ],
  outputDir: "vault-data/test-results"
});
