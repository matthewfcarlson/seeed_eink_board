/**
 * Self-contained Web Bluetooth pairing page for provisioning an EE02 board —
 * replaces the old AP-mode/STA-mode HTTP captive portal (config_server.h/.cpp,
 * removed from the firmware). No build step, vanilla JS. Pairs directly with the
 * device's BLE GATT service (see firmware/src/ble_provisioning.h for the schema)
 * over the browser's Web Bluetooth API — no need to join a temporary WiFi network
 * first, and no secrets pass through this worker (the browser talks to the board
 * directly over BLE).
 *
 * Requires Chrome/Edge (desktop or Android) — Web Bluetooth isn't supported in
 * Safari/iOS, a limitation of the browser API itself, not this page.
 */
export function renderProvisionPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-Ink Device Setup</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Arial, sans-serif; max-width: 560px; margin: 32px auto; padding: 0 16px 64px; background: #f6f7f9; color: #222; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .hint { color: #666; font-size: 0.85em; margin-top: 4px; }
  .card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 18px; margin-bottom: 16px; }
  .row { margin-bottom: 14px; }
  label { display: block; font-weight: bold; margin-bottom: 6px; font-size: 0.9em; }
  input[type="text"], input[type="number"], input[type="password"], select {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em;
  }
  .checkbox-row { display: flex; align-items: center; gap: 8px; }
  .checkbox-row input { width: auto; }
  button { background: #0b67d0; color: white; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 0.95em; }
  button:hover { background: #0954ac; }
  button.ghost { background: transparent; color: #0b67d0; border: 1px solid #0b67d0; }
  button.ghost:hover { background: #eaf2fc; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .inline-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .message { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 0.9em; }
  .success { background: #e7f6ea; border: 1px solid #9bd0a7; }
  .error { background: #fdecec; border: 1px solid #e2a4a4; }
  .info { background: #eaf2fc; border: 1px solid #b8d4f5; }
  code { background: #eef1f4; border-radius: 4px; padding: 2px 5px; font-size: 0.85em; }
  #device-info { font-size: 0.85em; color: #555; }
  #form { display: none; }
</style>
</head>
<body>

<h1>E-Ink Device Setup</h1>
<p class="hint">Pairs directly with the board over Bluetooth &mdash; hold Button 1 during boot (or on first boot with no WiFi configured) to enter setup mode, then connect below.</p>

<div id="unsupported" class="message error" style="display:none;">
  This browser doesn't support Web Bluetooth. Use an up-to-date Chrome or Edge on desktop or Android &mdash; Safari/iOS doesn't support it.
</div>

<div id="top-message"></div>

<div class="card" id="connect-card">
  <button id="connect-btn">Connect to device</button>
  <p class="hint">Your browser will show a picker listing nearby devices named "EInk-Setup".</p>
</div>

<div class="card" id="form">
  <div id="device-info"></div>

  <div class="row" style="margin-top:14px;">
    <label>WiFi Network</label>
    <div class="inline-form">
      <select id="wifi-ssid-select" style="flex:1;"><option value="">(scan or type below)</option></select>
      <button class="ghost" id="scan-btn" type="button">Scan</button>
    </div>
    <input type="text" id="wifi-ssid" placeholder="Network name (SSID)" style="margin-top:8px;">
  </div>
  <div class="row">
    <label>WiFi Password</label>
    <input type="password" id="wifi-password" placeholder="Leave blank to keep the current password">
  </div>

  <div class="row">
    <label>Server Host</label>
    <input type="text" id="host" placeholder="e.g. eink.example.com">
  </div>
  <div class="row">
    <label>Server Port</label>
    <input type="number" id="port" min="1" max="65535">
  </div>
  <div class="row checkbox-row">
    <input type="checkbox" id="use_https">
    <label for="use_https" style="margin-bottom:0;">Use HTTPS</label>
  </div>
  <div class="row">
    <label>Image Endpoint</label>
    <input type="text" id="endpoint" placeholder="/image_packed">
  </div>
  <div class="row">
    <label>Refresh Interval (minutes)</label>
    <input type="number" id="sleep_minutes" min="1" max="1440">
  </div>
  <div class="row">
    <label>Active Start Hour (0-23, local time)</label>
    <input type="number" id="active_start_hour" min="0" max="23">
  </div>
  <div class="row">
    <label>Active End Hour (0-23, local time)</label>
    <input type="number" id="active_end_hour" min="0" max="23">
  </div>
  <div class="row">
    <label>Timezone Offset (minutes from UTC)</label>
    <input type="number" id="timezone_offset_minutes" min="-720" max="840">
  </div>

  <div class="inline-form">
    <button id="save-btn">Save &amp; Reboot</button>
    <button class="ghost" id="disconnect-btn" type="button">Disconnect</button>
  </div>
</div>

<script>
const SERVICE_UUID = "00dc0948-cda5-4429-b7f3-5ea67f1b1347";
const CHAR_INFO_UUID = "7a209705-d097-43bb-a724-a41d29504486";
const CHAR_CONFIG_UUID = "514a006a-319b-4e01-ba80-aa38bf8e5b1f";
const CHAR_COMMAND_UUID = "1bc65320-3316-4de8-8a2c-89c89fa792ff";
const CHAR_SCAN_RESULTS_UUID = "97c497fa-7e94-4fe6-bad2-68ffd9d34d5e";

let gattServer = null;
let infoChar = null;
let configWriteChar = null;
let commandChar = null;
let scanResultsChar = null;

function showMessage(text, kind) {
  const el = document.getElementById("top-message");
  el.innerHTML = text ? '<div class="message ' + kind + '">' + escapeHtml(text) + "</div>" : "";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function textFromValue(dataView) {
  return new TextDecoder().decode(dataView);
}

function applyInfo(info) {
  document.getElementById("device-info").innerHTML =
    "MAC: <code>" + escapeHtml(info.device_mac) + "</code> &middot; " +
    "Firmware: <code>" + escapeHtml(info.firmware_version) + "</code> &middot; " +
    "State: <code>" + escapeHtml(info.state) + "</code>";

  document.getElementById("wifi-ssid").value = info.wifi_ssid || "";
  document.getElementById("host").value = info.host || "";
  document.getElementById("port").value = info.port || "";
  document.getElementById("use_https").checked = !!info.use_https;
  document.getElementById("endpoint").value = info.endpoint || "";
  document.getElementById("sleep_minutes").value = info.sleep_minutes || "";
  document.getElementById("active_start_hour").value = info.active_start_hour ?? "";
  document.getElementById("active_end_hour").value = info.active_end_hour ?? "";
  document.getElementById("timezone_offset_minutes").value = info.timezone_offset_minutes ?? "";

  if (info.state === "saved_rebooting") {
    showMessage("Saved! The device is rebooting and will connect to your WiFi shortly.", "success");
  }
}

function applyScanResults(networks) {
  const select = document.getElementById("wifi-ssid-select");
  select.innerHTML = '<option value="">(scan or type below)</option>' +
    networks
      .slice()
      .sort((a, b) => b.r - a.r)
      .map((n) => '<option value="' + escapeHtml(n.s) + '">' + escapeHtml(n.s) + (n.o ? " (open)" : "") + "</option>")
      .join("");
}

document.getElementById("wifi-ssid-select").addEventListener("change", (e) => {
  if (e.target.value) document.getElementById("wifi-ssid").value = e.target.value;
});

async function connect() {
  try {
    const device = await navigator.bluetooth.requestDevice({
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
    infoChar.addEventListener("characteristicvaluechanged", (e) => {
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
      } catch (err) {
        showMessage("Failed to read scan results: " + err.message, "error");
      }
    });

    const initialInfo = JSON.parse(textFromValue(await infoChar.readValue()));
    applyInfo(initialInfo);

    document.getElementById("connect-card").style.display = "none";
    document.getElementById("form").style.display = "block";
    showMessage("Connected.", "success");
  } catch (err) {
    showMessage("Failed to connect: " + err.message, "error");
  }
}

function onDisconnected() {
  showMessage("Disconnected. If you just saved, the device is rebooting and connecting to your WiFi.", "info");
  document.getElementById("connect-card").style.display = "block";
  document.getElementById("form").style.display = "none";
  gattServer = null;
}

document.getElementById("connect-btn").addEventListener("click", connect);

document.getElementById("disconnect-btn").addEventListener("click", () => {
  if (gattServer && gattServer.connected) gattServer.disconnect();
});

document.getElementById("scan-btn").addEventListener("click", async () => {
  try {
    await commandChar.writeValueWithResponse(new TextEncoder().encode("scan"));
    showMessage("Scanning for networks...", "info");
  } catch (err) {
    showMessage("Failed to start scan: " + err.message, "error");
  }
});

document.getElementById("save-btn").addEventListener("click", async () => {
  const config = {
    wifi_ssid: document.getElementById("wifi-ssid").value.trim(),
    host: document.getElementById("host").value.trim(),
    port: Number(document.getElementById("port").value),
    use_https: document.getElementById("use_https").checked,
    endpoint: document.getElementById("endpoint").value.trim(),
    sleep_minutes: Number(document.getElementById("sleep_minutes").value),
    active_start_hour: Number(document.getElementById("active_start_hour").value),
    active_end_hour: Number(document.getElementById("active_end_hour").value),
    timezone_offset_minutes: Number(document.getElementById("timezone_offset_minutes").value),
  };
  const password = document.getElementById("wifi-password").value;
  if (password.length > 0) config.wifi_password = password;

  if (!config.wifi_ssid) {
    showMessage("WiFi network name is required.", "error");
    return;
  }

  try {
    await configWriteChar.writeValueWithResponse(new TextEncoder().encode(JSON.stringify(config)));
    await commandChar.writeValueWithResponse(new TextEncoder().encode("save"));
    showMessage("Saving and rebooting the device...", "info");
  } catch (err) {
    showMessage("Failed to save: " + err.message, "error");
  }
});

if (!navigator.bluetooth) {
  document.getElementById("unsupported").style.display = "block";
  document.getElementById("connect-btn").disabled = true;
}
</script>
</body>
</html>`;
}
