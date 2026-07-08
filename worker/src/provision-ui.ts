/**
 * Web Bluetooth pairing page shell for provisioning an EE02 board — replaces
 * the old AP-mode/STA-mode HTTP captive portal (config_server.h/.cpp, removed
 * from the firmware). Pairs directly with the device's BLE GATT service (see
 * firmware/src/ble_provisioning.h for the schema) over the browser's Web
 * Bluetooth API — no need to join a temporary WiFi network first, and no
 * secrets pass through this worker (the browser talks to the board directly
 * over BLE).
 *
 * Requires Chrome/Edge (desktop or Android) — Web Bluetooth isn't supported in
 * Safari/iOS, a limitation of the browser API itself, not this page.
 *
 * The client-side logic lives in src/client/provision.ts, compiled by
 * scripts/build-client.mjs to public/static/provision.js and served as a
 * static asset (see [assets] in wrangler.toml) — not embedded here as a string.
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

<script src="/static/provision.js"></script>
</body>
</html>`;
}
