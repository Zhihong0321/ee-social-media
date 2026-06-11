const { test } = require("@playwright/test");
const { runFacebookHelloWorld } = require("../agents/facebook-hello-world");

test("facebook agent posts hello world", async () => {
  await runFacebookHelloWorld({
    postText: process.env.POST_TEXT || "Hello world",
    headless: process.env.HEADLESS === "1"
  });
});
