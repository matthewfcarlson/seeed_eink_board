import { chromium } from "playwright";

const BASE_URL = "http://localhost:8791";
const EMAIL = "passkey-e2e@example.com";

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("dialog", async (dialog) => {
  console.log("[dialog]", dialog.message());
  await dialog.accept();
});
page.on("console", (msg) => console.log("[console]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

const client = await page.context().newCDPSession(page);
await client.send("WebAuthn.enable");
const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
console.log("Authenticator:", authenticatorId);

await page.goto(`${BASE_URL}/admin`);

// --- Sign up ---
await page.click("#tab-signup");
await page.fill("#signup-email-input", EMAIL);
await page.click("#passkey-signup-btn");

await page.waitForSelector("#app", { state: "visible", timeout: 15000 });
console.log("SIGNUP OK: #app visible");
const whoamiAfterSignup = await page.textContent("#whoami");
console.log("whoami after signup:", whoamiAfterSignup);

// --- Log out ---
await page.click("#logout-btn");
await page.waitForSelector("#login", { state: "visible", timeout: 5000 });
console.log("LOGOUT OK");

// Clear localStorage api key to make sure the *login* path (not a cached key) is exercised
await page.evaluate(() => localStorage.removeItem("eink_admin_api_key"));
await page.reload();

// --- Log in with passkey ---
await page.click("#tab-login");
await page.fill("#login-email-input", EMAIL);
await page.click("#passkey-login-btn");

await page.waitForSelector("#app", { state: "visible", timeout: 15000 });
console.log("LOGIN OK: #app visible");
const whoamiAfterLogin = await page.textContent("#whoami");
console.log("whoami after login:", whoamiAfterLogin);

// --- Sanity: register a device while logged in via passkey-issued key ---
await page.fill("#new-device-mac", "aabbcc112233");
await page.fill("#new-device-label", "Playwright Test Frame");
await page.click("#register-device-btn");
await page.waitForTimeout(1000);
const devicesHtml = await page.innerHTML("#devices-table");
console.log("devices table contains mac:", devicesHtml.includes("aabbcc112233"));

await browser.close();
console.log("DONE");
