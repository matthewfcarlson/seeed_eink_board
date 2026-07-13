/**
 * Admin single-page app shell. Calls the JSON admin API (Authorization: Bearer
 * <api_key>) client-side. The API key is kept in localStorage only — this route
 * itself serves no secrets and needs no server-side auth. Accounts are created
 * and re-authenticated via a passkey ceremony (see routes/auth-passkey.ts); a
 * successful ceremony just mints an API key, which is then used exactly like any
 * Bearer-token API client.
 *
 * The client-side logic lives in src/client/admin.ts, compiled by
 * scripts/build-client.mjs to public/static/admin.js and served as a static
 * asset (see [assets] in wrangler.toml) — not embedded here as a string.
 */
export function renderAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-Ink Admin</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Arial, sans-serif; max-width: 1080px; margin: 32px auto; padding: 0 16px 64px; background: #f6f7f9; color: #222; }
  h1, h2, h3 { margin-bottom: 0.4rem; }
  h1 { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 1.5rem; }
  .card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 18px; margin-bottom: 16px; }
  .row { margin-bottom: 14px; }
  label { display: block; font-weight: bold; margin-bottom: 6px; font-size: 0.9em; }
  input[type="text"], input[type="number"], input[type="password"], select {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em;
  }
  button { background: #0b67d0; color: white; border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
  button:hover { background: #0954ac; }
  button.danger { background: #c43d31; }
  button.danger:hover { background: #a13024; }
  button.ghost { background: transparent; color: #0b67d0; border: 1px solid #0b67d0; }
  button.ghost:hover { background: #eaf2fc; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .inline-form { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
  .inline-form .row { margin-bottom: 0; flex: 1 1 140px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #eee; padding: 8px; text-align: left; vertical-align: top; font-size: 0.9em; }
  code { background: #eef1f4; border-radius: 4px; padding: 2px 5px; font-size: 0.85em; }
  img.thumb { display: block; border-radius: 3px; border: 1px solid #ddd; object-fit: cover; }
  .thumb-wrap { position: relative; display: inline-block; }
  .thumb-popup {
    display: none; position: fixed; z-index: 30;
    background: white; border: 1px solid #ccc; border-radius: 6px; padding: 5px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.3);
  }
  .thumb-wrap:hover .thumb-popup { display: block; }
  .thumb-popup img { display: block; max-width: 45vw; max-height: 70vh; border-radius: 3px; }
  .thumb-popup .hint { padding: 10px; margin: 0; }
  .hint { color: #666; font-size: 0.85em; margin-top: 4px; }
  .message { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 0.9em; }
  .success { background: #e7f6ea; border: 1px solid #9bd0a7; }
  .error { background: #fdecec; border: 1px solid #e2a4a4; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75em; background: #eef1f4; }
  .bucket-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 40; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: white; border-radius: 8px; padding: 20px; max-width: 420px; width: 90%; max-height: 80vh; overflow: auto; }
  .modal h3 { margin-top: 0; }
  .bucket-checkbox-list label { display: flex; align-items: center; gap: 8px; font-weight: normal; margin-bottom: 6px; }
  .collab-list { list-style: none; padding: 0; margin: 8px 0; }
  .collab-list li { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 0.9em; }
  .top-bar { display: flex; gap: 8px; align-items: center; }
  .top-bar span { font-size: 0.85em; color: #555; }
  #app { display: none; }
  #login { max-width: 420px; margin: 60px auto; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #ddd; }
  .tab { padding: 8px 14px; cursor: pointer; font-size: 0.9em; font-weight: bold; color: #666; border-bottom: 2px solid transparent; }
  .tab.active { color: #0b67d0; border-bottom-color: #0b67d0; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  details.api-key-fallback { margin-top: 18px; font-size: 0.9em; }
  details.api-key-fallback summary { cursor: pointer; color: #666; }
  details.api-key-fallback .row { margin-top: 10px; }
</style>
</head>
<body>

<div id="login" class="card">
  <h2>E-Ink Admin</h2>
  <div id="login-message"></div>

  <div class="tabs">
    <div class="tab active" id="tab-login" onclick="switchTab('login')">Log in</div>
    <div class="tab" id="tab-signup" onclick="switchTab('signup')">Create account</div>
  </div>

  <div class="tab-panel active" id="panel-login">
    <p class="hint">Log in with the passkey you registered for your account. Your browser/OS will show a picker — there's no username to type.</p>
    <button id="passkey-login-btn">Log in with passkey</button>
  </div>

  <div class="tab-panel" id="panel-signup">
    <p class="hint">No signup form, no email, no password — creating an account just means registering a passkey (Face ID, Touch ID, Windows Hello, or a security key). The passkey is the whole account.</p>
    <button id="passkey-signup-btn">Create account with passkey</button>
  </div>

  <details class="api-key-fallback">
    <summary>Use an API key instead</summary>
    <div class="row">
      <label for="api-key-input">API Key</label>
      <input type="password" id="api-key-input" placeholder="eink_...">
    </div>
    <button id="login-btn">Log in with API key</button>
  </details>
</div>

<div id="app">
  <h1>
    E-Ink Admin
    <span class="top-bar">
      <span id="whoami"></span>
      <button class="ghost" id="logout-btn">Log out</button>
    </span>
  </h1>
  <div id="app-message"></div>
  <div id="claim-banner"></div>
  <div id="join-bucket-banner"></div>

  <div class="card">
    <h2>Devices</h2>
    <p class="hint">"Last image sent" is what the server handed the device on its last successful poll &mdash; e-ink holds whatever it last finished displaying even through power loss, so if a device died mid-refresh (or before one), the physical screen can lag behind this.</p>
    <table>
      <thead><tr><th>MAC</th><th>Label</th><th>Last image sent</th><th>Firmware</th><th>Last seen</th><th>Battery</th><th>Buckets</th><th>Schedule</th><th></th></tr></thead>
      <tbody id="devices-table"></tbody>
    </table>
    <div class="inline-form" style="margin-top:14px;">
      <div class="row">
        <label>MAC address</label>
        <input type="text" id="new-device-mac" placeholder="aabbccddeeff">
      </div>
      <div class="row">
        <label>Label</label>
        <input type="text" id="new-device-label" placeholder="Kitchen frame">
      </div>
      <button id="register-device-btn">Register Device</button>
    </div>
  </div>

  <div class="card">
    <h2>Image Buckets</h2>
    <p class="hint">Buckets are independent, shareable groups of images. Subscribe a device to any number of them via its "Manage" button above.</p>
    <div class="inline-form">
      <div class="row">
        <label>New bucket label</label>
        <input type="text" id="new-bucket-label" placeholder="Living room rotation">
      </div>
      <button id="create-bucket-btn">Create bucket</button>
    </div>
  </div>
  <div class="bucket-grid" id="buckets"></div>

  <div class="modal-overlay" id="bucket-modal-overlay">
    <div class="modal">
      <h3>Manage buckets</h3>
      <div id="bucket-modal-list"></div>
      <div class="inline-form" style="margin-top:14px;">
        <button id="bucket-modal-save-btn">Save</button>
        <button class="ghost" id="bucket-modal-cancel-btn">Cancel</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="schedule-modal-overlay">
    <div class="modal">
      <h3>Schedule override</h3>
      <div id="schedule-modal-content"></div>
      <div class="inline-form" style="margin-top:14px;">
        <button class="ghost" id="schedule-modal-close-btn">Close</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Firmware (OTA)</h2>
    <p class="hint">Devices only ever update their firmware when a target version is set below — syncing a release from GitHub just makes it available to target.</p>
    <table>
      <thead><tr><th>Version</th><th>Tag</th><th>Size</th><th>SHA-256</th><th>Synced</th></tr></thead>
      <tbody id="firmware-releases-table"></tbody>
    </table>
    <div class="inline-form" style="margin-top:14px;">
      <button id="firmware-sync-btn">Sync from GitHub</button>
      <span class="hint">Also runs automatically every 6 hours.</span>
    </div>

    <h3 style="margin-top:22px;">Targets</h3>
    <p class="hint">Each device only ever runs a version an admin has explicitly targeted for its own MAC &mdash; there's no shared fallback. Clearing a target leaves that device on whatever it's already running.</p>
    <table>
      <thead><tr><th>Target</th><th>Version</th><th>Updated</th><th></th></tr></thead>
      <tbody id="firmware-targets-table"></tbody>
    </table>
    <div class="inline-form" style="margin-top:14px;">
      <div class="row">
        <label>Target</label>
        <select id="firmware-target-select"></select>
      </div>
      <div class="row">
        <label>Version</label>
        <select id="firmware-version-select"></select>
      </div>
      <button id="firmware-target-save-btn">Set Target</button>
    </div>
  </div>

  <div class="card">
    <h3>API Key</h3>
    <p class="hint">Rotating your key immediately invalidates the old one — anything using it (scripts, the firmware config page) will need the new value.</p>
    <button class="ghost" id="rotate-key-btn">Rotate API Key</button>
  </div>

  <div class="card">
    <h3>Account</h3>
    <button class="ghost" id="edit-name-btn">Edit name</button>
  </div>
</div>

<script src="/static/admin.js"></script>
</body>
</html>`;
}
