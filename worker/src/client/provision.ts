/**
 * Client-side script for the BLE device-setup page (see ../provision-ui.ts).
 * Bundled by scripts/build-client.mjs into public/static/provision.js. Pairs
 * directly with the board's GATT service over Web Bluetooth — see
 * firmware/lib/common/ble_provisioning.h for the characteristic schema. Web
 * Bluetooth isn't in TypeScript's bundled DOM lib, so navigator.bluetooth and
 * the GATT objects it returns are treated as `any` here rather than
 * hand-rolling types for an experimental API.
 *
 * A `?sim=<origin>` query param switches the transport to the device
 * simulator's fake GATT-over-HTTP+SSE server (simulator/src/server.ts)
 * instead of real Web Bluetooth — see simulator/README.md. Same
 * INFO/CONFIG_WRITE/COMMAND/SCAN_RESULTS JSON contract either way; only
 * connect/disconnect/write plumbing branches on `simOrigin` below. No
 * behavior change to the real BLE path when the param is absent.
 *
 * Web Bluetooth doesn't exist on iOS Safari at all (WebKit's own
 * limitation) — `@beacio/core/auto` patches `navigator.bluetooth` in on
 * Safari (via the Beacio companion app/Safari extension, see
 * https://beacio.com) and, where no real or extension-backed Bluetooth is
 * available at all, installs a stub whose `requestDevice()` shows Beacio's
 * own install prompt and rejects — so the existing `connectBle()` catch
 * block below surfaces that rejection like any other failed connect, no
 * bespoke UA-sniffing needed here. No apiKey is configured, which keeps
 * this to the polyfill only — no telemetry calls fire without one.
 */
import "@beacio/core/auto";

export {};

const SERVICE_UUID = "00dc0948-cda5-4429-b7f3-5ea67f1b1347";
const CHAR_INFO_UUID = "7a209705-d097-43bb-a724-a41d29504486";
const CHAR_CONFIG_UUID = "514a006a-319b-4e01-ba80-aa38bf8e5b1f";
const CHAR_COMMAND_UUID = "1bc65320-3316-4de8-8a2c-89c89fa792ff";
const CHAR_SCAN_RESULTS_UUID = "97c497fa-7e94-4fe6-bad2-68ffd9d34d5e";

let simOrigin = new URLSearchParams(window.location.search).get("sim");

// firmware/simulator/stubs/NimBLEDevice.h's fixed SIM_GATT_PORT - one
// simulator process (whichever board is currently in config mode) can be
// listening here at a time. Only ever probed when this page's own origin is
// itself a local dev one (see isLocalDevOrigin below) - a deployed page has
// no reason to go looking at a visitor's localhost, and doing so anyway
// would be a pointless (and slightly rude) port probe against every real
// visitor.
const LOCAL_SIMULATOR_ORIGIN = "http://localhost:8790";
const LOCAL_SIMULATOR_PROBE_TIMEOUT_MS = 500;

function isLocalDevOrigin(): boolean {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

/** Best-effort: is firmware/simulator's fake GATT bridge listening right
 *  now? Times out quickly rather than waiting out a full connection-refused
 *  cycle, since "nothing there" needs to feel instant, not like a hang. */
async function detectLocalSimulator(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_SIMULATOR_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${LOCAL_SIMULATOR_ORIGIN}/gatt/info`, { signal: controller.signal });
    return res.ok ? LOCAL_SIMULATOR_ORIGIN : null;
  } catch {
    return null; // nothing listening, or it errored - either way, no simulator to use
  } finally {
    clearTimeout(timeout);
  }
}

// Same localStorage key admin.ts's KEY_STORAGE uses — this page and /admin
// are served from the same origin, so a passkey login there is already
// visible here, letting this page register a paired device straight to that
// account without a separate login step.
const KEY_STORAGE = "eink_admin_api_key";
function getApiKey(): string | null { return localStorage.getItem(KEY_STORAGE); }

let gattServer: any = null;
let infoChar: any = null;
let configWriteChar: any = null;
let commandChar: any = null;
let scanResultsChar: any = null;
let simEvents: EventSource | null = null;
let currentDeviceMac: string | null = null;
// This device's HMAC secret, present in INFO only while unclaimed (see
// ble_provisioning.h) — proves this browser actually paired with the physical
// device over BLE, not just guessed its MAC (every board shares the same
// vendor OUI). Sent once with the register call below, never displayed.
let currentDeviceSecret: string | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function showMessage(text: string, kind: string) {
  el("top-message").innerHTML = text ? '<div class="message ' + kind + '">' + escapeHtml(text) + "</div>" : "";
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c] ?? c);
}

function textFromValue(dataView: DataView): string {
  return new TextDecoder().decode(dataView);
}

function applyInfo(info: any) {
  el("device-info").innerHTML =
    "MAC: <code>" + escapeHtml(info.device_mac) + "</code> &middot; " +
    "Firmware: <code>" + escapeHtml(info.firmware_version) + "</code> &middot; " +
    "State: <code>" + escapeHtml(info.state) + "</code>";

  currentDeviceMac = info.device_mac || null;
  currentDeviceSecret = info.secret || null;
  el("register-card").style.display = currentDeviceMac ? "block" : "none";
  renderRegisterSection();

  el<HTMLInputElement>("wifi-ssid").value = info.wifi_ssid || "";
  el<HTMLInputElement>("host").value = info.host || "";
  el<HTMLInputElement>("port").value = info.port || "";
  el<HTMLInputElement>("use_https").checked = !!info.use_https;
  el<HTMLInputElement>("endpoint").value = info.endpoint || "";
  el<HTMLInputElement>("sleep_minutes").value = info.sleep_minutes || "";
  el<HTMLInputElement>("active_start_hour").value = info.active_start_hour ?? "";
  el<HTMLInputElement>("active_end_hour").value = info.active_end_hour ?? "";
  el<HTMLInputElement>("timezone_offset_minutes").value = info.timezone_offset_minutes ?? "";

  if (info.state === "saved_rebooting") {
    showMessage("Saved! The device is rebooting and will connect to your WiFi shortly.", "success");
  }
}

function applyScanResults(networks: any[]) {
  const select = el<HTMLSelectElement>("wifi-ssid-select");
  select.innerHTML = '<option value="">(scan or type below)</option>' +
    networks
      .slice()
      .sort((a, b) => b.r - a.r)
      .map((n) => '<option value="' + escapeHtml(n.s) + '">' + escapeHtml(n.s) + (n.o ? " (open)" : "") + "</option>")
      .join("");
}

el<HTMLSelectElement>("wifi-ssid-select").addEventListener("change", (e) => {
  const value = (e.target as HTMLSelectElement).value;
  if (value) el<HTMLInputElement>("wifi-ssid").value = value;
});

async function connectBle() {
  try {
    const device = await (navigator as any).bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    device.addEventListener("gattserverdisconnected", onDisconnected);

    showMessage("Connecting...", "info");
    gattServer = await device.gatt.connect();
    const service = await gattServer.getPrimaryService(SERVICE_UUID);

    infoChar = await service.getCharacteristic(CHAR_INFO_UUID);
    configWriteChar = await service.getCharacteristic(CHAR_CONFIG_UUID);
    commandChar = await service.getCharacteristic(CHAR_COMMAND_UUID);
    scanResultsChar = await service.getCharacteristic(CHAR_SCAN_RESULTS_UUID);

    await infoChar.startNotifications();
    infoChar.addEventListener("characteristicvaluechanged", (e: any) => {
      applyInfo(JSON.parse(textFromValue(e.target.value)));
    });

    await scanResultsChar.startNotifications();
    // Deliberately re-read rather than trust the notification's own payload: a
    // single notification can't span multiple BLE packets, so if it's cut short
    // by a smaller-than-expected negotiated MTU the delivered value would be
    // truncated. A read supports the GATT "long read" procedure (multiple
    // request/response round trips), so it reliably retrieves the full value.
    scanResultsChar.addEventListener("characteristicvaluechanged", async () => {
      try {
        const value = await scanResultsChar.readValue();
        applyScanResults(JSON.parse(textFromValue(value)));
      } catch (err: any) {
        showMessage("Failed to read scan results: " + err.message, "error");
      }
    });

    const initialInfo = JSON.parse(textFromValue(await infoChar.readValue()));
    applyInfo(initialInfo);

    el("connect-card").style.display = "none";
    el("form").style.display = "block";
    showMessage("Connected.", "success");
  } catch (err: any) {
    showMessage("Failed to connect: " + err.message, "error");
  }
}

/** Simulator transport: same INFO/SCAN_RESULTS payloads, delivered over a
 *  plain fetch() + Server-Sent Events instead of Web Bluetooth GATT — see
 *  simulator/src/server.ts's /gatt/* routes. */
async function connectSim() {
  try {
    showMessage("Connecting to simulator...", "info");
    const res = await fetch(`${simOrigin}/gatt/info`);
    if (!res.ok) throw new Error(`simulator returned HTTP ${res.status}`);
    applyInfo(await res.json());

    simEvents?.close();
    simEvents = new EventSource(`${simOrigin}/gatt/events`);
    simEvents.addEventListener("info", (e: any) => applyInfo(JSON.parse(e.data)));
    simEvents.addEventListener("scan_results", (e: any) => applyScanResults(JSON.parse(e.data)));
    simEvents.onerror = () => showMessage("Lost connection to the simulator.", "error");

    el("connect-card").style.display = "none";
    el("form").style.display = "block";
    showMessage("Connected to simulator.", "success");
  } catch (err: any) {
    showMessage("Failed to connect to simulator: " + err.message, "error");
  }
}

async function connect() {
  if (simOrigin) return connectSim();
  if (isLocalDevOrigin()) {
    showMessage("Looking for a local simulator...", "info");
    const detected = await detectLocalSimulator();
    if (detected) {
      simOrigin = detected;
      return connectSim();
    }
  }
  return connectBle();
}

function onDisconnected() {
  showMessage("Disconnected. If you just saved, the device is rebooting and connecting to your WiFi.", "info");
  el("connect-card").style.display = "block";
  el("form").style.display = "none";
  el("register-card").style.display = "none";
  gattServer = null;
  currentDeviceMac = null;
  currentDeviceSecret = null;
}

// ---- Account login status / register-to-account ----

let loggedInUser: { id: string; display_name: string | null } | null = null;

async function refreshLoginStatus() {
  const key = getApiKey();
  if (!key) {
    loggedInUser = null;
    el("login-status").innerHTML = '<a href="/admin">Log in</a>';
    renderRegisterSection();
    return;
  }
  try {
    const res = await fetch("/admin/me", { headers: { Authorization: "Bearer " + key } });
    if (!res.ok) throw new Error("invalid key");
    loggedInUser = await res.json();
    el("login-status").textContent = loggedInUser?.display_name
      ? "Logged in as " + loggedInUser.display_name
      : "Logged in";
  } catch {
    loggedInUser = null;
    el("login-status").innerHTML = '<a href="/admin">Log in</a>';
  }
  renderRegisterSection();
}

function renderRegisterSection() {
  if (!currentDeviceMac) return;
  el("register-logged-in").style.display = loggedInUser ? "block" : "none";
  el("register-logged-out").style.display = loggedInUser ? "none" : "block";
}

el("register-btn").addEventListener("click", async () => {
  const key = getApiKey();
  if (!key || !currentDeviceMac) return;
  const label = el<HTMLInputElement>("register-label").value.trim();
  try {
    const body: any = { mac: currentDeviceMac, label };
    // Only present pre-claim (see applyInfo) — omitted entirely once a device
    // is already registered, same as the manual "Claim device" modal on /admin.
    if (currentDeviceSecret) body.secret = currentDeviceSecret;
    const res = await fetch("/admin/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status + " " + res.statusText));
    el("register-message").innerHTML = '<div class="message success">Registered to your account.</div>';
  } catch (err: any) {
    el("register-message").innerHTML =
      '<div class="message error">Failed to register: ' + escapeHtml(err.message) + "</div>";
  }
});

void refreshLoginStatus();

el("connect-btn").addEventListener("click", connect);

el("disconnect-btn").addEventListener("click", () => {
  if (simOrigin) {
    simEvents?.close();
    simEvents = null;
    onDisconnected();
    return;
  }
  if (gattServer && gattServer.connected) gattServer.disconnect();
});

el("scan-btn").addEventListener("click", async () => {
  try {
    if (simOrigin) {
      await fetch(`${simOrigin}/gatt/command`, { method: "POST", body: "scan" });
    } else {
      await commandChar.writeValueWithResponse(new TextEncoder().encode("scan"));
    }
    showMessage("Scanning for networks...", "info");
  } catch (err: any) {
    showMessage("Failed to start scan: " + err.message, "error");
  }
});

el("save-btn").addEventListener("click", async () => {
  const config: any = {
    wifi_ssid: el<HTMLInputElement>("wifi-ssid").value.trim(),
    host: el<HTMLInputElement>("host").value.trim(),
    port: Number(el<HTMLInputElement>("port").value),
    use_https: el<HTMLInputElement>("use_https").checked,
    endpoint: el<HTMLInputElement>("endpoint").value.trim(),
    sleep_minutes: Number(el<HTMLInputElement>("sleep_minutes").value),
    active_start_hour: Number(el<HTMLInputElement>("active_start_hour").value),
    active_end_hour: Number(el<HTMLInputElement>("active_end_hour").value),
    timezone_offset_minutes: Number(el<HTMLInputElement>("timezone_offset_minutes").value),
  };
  const password = el<HTMLInputElement>("wifi-password").value;
  if (password.length > 0) config.wifi_password = password;

  if (!config.wifi_ssid) {
    showMessage("WiFi network name is required.", "error");
    return;
  }

  try {
    if (simOrigin) {
      await fetch(`${simOrigin}/gatt/config`, { method: "POST", body: JSON.stringify(config) });
      await fetch(`${simOrigin}/gatt/command`, { method: "POST", body: "save" });
    } else {
      await configWriteChar.writeValueWithResponse(new TextEncoder().encode(JSON.stringify(config)));
      await commandChar.writeValueWithResponse(new TextEncoder().encode("save"));
    }
    showMessage("Saving and rebooting the device...", "info");
  } catch (err: any) {
    showMessage("Failed to save: " + err.message, "error");
  }
});

if (simOrigin) {
  // No device picker for a fake HTTP transport - just connect immediately.
  void connectSim();
} else if (!(navigator as any).bluetooth && !isLocalDevOrigin()) {
  // @beacio/core/auto installs a stub navigator.bluetooth on essentially
  // every browser (real, extension-backed, or its own install-prompting
  // dummy) - this only fires in the (now rare) case none of those apply. On
  // a local dev origin, leave the button enabled anyway - connect() tries a
  // local simulator before giving up, so "no Bluetooth" isn't necessarily
  // the end of the story there the way it is on a real deployment.
  el("unsupported").style.display = "block";
  el<HTMLButtonElement>("connect-btn").disabled = true;
}
