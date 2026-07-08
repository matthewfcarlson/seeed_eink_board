/**
 * Client-side script for the BLE device-setup page (see ../provision-ui.ts).
 * Bundled by scripts/build-client.mjs into public/static/provision.js. Pairs
 * directly with the board's GATT service over Web Bluetooth — see
 * firmware/src/ble_provisioning.h for the characteristic schema. Web Bluetooth
 * isn't in TypeScript's bundled DOM lib, so navigator.bluetooth and the GATT
 * objects it returns are treated as `any` here rather than hand-rolling types
 * for an experimental API.
 */
export {};

const SERVICE_UUID = "00dc0948-cda5-4429-b7f3-5ea67f1b1347";
const CHAR_INFO_UUID = "7a209705-d097-43bb-a724-a41d29504486";
const CHAR_CONFIG_UUID = "514a006a-319b-4e01-ba80-aa38bf8e5b1f";
const CHAR_COMMAND_UUID = "1bc65320-3316-4de8-8a2c-89c89fa792ff";
const CHAR_SCAN_RESULTS_UUID = "97c497fa-7e94-4fe6-bad2-68ffd9d34d5e";

let gattServer: any = null;
let infoChar: any = null;
let configWriteChar: any = null;
let commandChar: any = null;
let scanResultsChar: any = null;

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

async function connect() {
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

function onDisconnected() {
  showMessage("Disconnected. If you just saved, the device is rebooting and connecting to your WiFi.", "info");
  el("connect-card").style.display = "block";
  el("form").style.display = "none";
  gattServer = null;
}

el("connect-btn").addEventListener("click", connect);

el("disconnect-btn").addEventListener("click", () => {
  if (gattServer && gattServer.connected) gattServer.disconnect();
});

el("scan-btn").addEventListener("click", async () => {
  try {
    await commandChar.writeValueWithResponse(new TextEncoder().encode("scan"));
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
    await configWriteChar.writeValueWithResponse(new TextEncoder().encode(JSON.stringify(config)));
    await commandChar.writeValueWithResponse(new TextEncoder().encode("save"));
    showMessage("Saving and rebooting the device...", "info");
  } catch (err: any) {
    showMessage("Failed to save: " + err.message, "error");
  }
});

if (!(navigator as any).bluetooth) {
  el("unsupported").style.display = "block";
  el<HTMLButtonElement>("connect-btn").disabled = true;
}
