/**
 * Web Bluetooth pairing page shell for provisioning an EE02 board — replaces
 * the old AP-mode/STA-mode HTTP captive portal (config_server.h/.cpp, removed
 * from the firmware). Pairs directly with the device's BLE GATT service (see
 * firmware/src/ble_provisioning.h for the schema) over the browser's Web
 * Bluetooth API — no need to join a temporary WiFi network first, and no
 * secrets pass through this worker (the browser talks to the board directly
 * over BLE).
 *
 * Works in Chrome/Edge (desktop or Android) natively. Safari/iOS has no Web
 * Bluetooth API of its own (a limitation of the browser, not this page) —
 * src/client/provision.ts pulls in the Beacio polyfill (@beacio/core/auto,
 * see https://beacio.com) to cover that case instead of just turning those
 * visitors away; it prompts to install its companion app/extension itself
 * when needed.
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
<link rel="stylesheet" href="/static/style.css">
<style>
  #device-info { font-size: 0.85em; color: var(--ink-soft); }
  #form { display: none; }
  #register-card { display: none; }
  .brand-link { text-decoration: none; color: inherit; }
  #login-status { font-size: 0.88em; }
  #login-status a { color: inherit; font-weight: 700; }
</style>
</head>
<body>

<div class="page page-narrow">

<div class="topbar">
  <a class="brand brand-link" href="/">
    <div class="brand-dots"><span></span><span></span><span></span><span></span><span></span><span></span></div>
    <span class="brand-name">E-Ink Setup</span>
  </a>
  <div class="topbar-right">
    <span id="login-status"></span>
  </div>
</div>

<h1>E-Ink Device Setup</h1>
<p class="hint hint-block">Pairs directly with the board over Bluetooth &mdash; hold Button 1 during boot (or on first boot with no WiFi configured) to enter setup mode, then connect below.</p>

<div id="unsupported" class="message error" style="display:none;">
  This browser doesn't support Web Bluetooth, even with the <a href="https://beacio.com" target="_blank" rel="noopener">Beacio</a> polyfill. Try an up-to-date Chrome or Edge on desktop or Android instead.
</div>

<div id="top-message"></div>

<div class="card" id="connect-card">
  <button id="connect-btn">Connect to device</button>
  <p class="hint">Your browser will show a picker listing nearby devices named "EInk-Setup".</p>
</div>

<div class="card" id="register-card">
  <h2>Register to your account</h2>
  <div id="device-info"></div>
  <div id="register-message"></div>
  <div id="register-logged-out" class="hint hint-block" style="display:none;">
    <a href="/admin">Log in</a> to register this device to your account.
  </div>
  <div id="register-logged-in" style="display:none;">
    <div class="row">
      <label>Label</label>
      <input type="text" id="register-label" placeholder="Kitchen frame">
    </div>
    <button id="register-btn">Register device</button>
  </div>
</div>

<div class="card" id="form">
  <div id="wifi-sim-hint" class="hint hint-block" style="display:none;">This is a simulated device &mdash; WiFi is stubbed out and always reports connected, so these fields are disabled and ignored.</div>
  <div class="row">
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

</div>
<script src="/static/provision.js"></script>
</body>
</html>`;
}
