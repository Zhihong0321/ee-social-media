const { test } = require("@playwright/test");
const { runGoogleAuth } = require("../agents/google-auth");

test("google account authenticates with ee2fa authenticator code", async () => {
  await runGoogleAuth({
    username: process.env.GOOGLE_USERNAME,
    password: process.env.GOOGLE_PASSWORD,
    totpEmail: process.env.GOOGLE_TOTP_EMAIL,
    profileName: process.env.GOOGLE_PROFILE_NAME,
    headless: process.env.HEADLESS === "1"
  });
});
