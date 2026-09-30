/**
 * Admin single-page app shell. Calls the JSON admin API (Authorization: Bearer
 * <session token>) client-side. The token is kept in localStorage only — this route
 * itself serves no secrets and needs no server-side auth. Accounts are created
 * and re-authenticated via a passkey ceremony (see routes/auth-passkey.ts); a
 * successful ceremony mints a per-login session (see
 * migrations/0023_user_sessions.sql), which is then used exactly like any
 * Bearer-token API client. Tokens are format-compatible with the old API key
 * (`eink_…`), so a token pasted from another session still works — but each
 * browser must run its own ceremony to get one, since sessions can no longer
 * be rotated out of existence server-side.
 *
 * The client-side logic lives in src/client/admin.ts, compiled by
 * scripts/build-client.mjs to public/static/admin.js and served as a static
 * asset (see [assets] in wrangler.toml) — not embedded here as a string.
 *
 * Shared visual design lives in public/static/style.css (see that file's
 * header comment) — every element id below that admin.ts's el(id) reads or
 * writes must stay exactly as named; only classes/structure around them are
 * free to change.
 */
export function renderAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-Ink Admin</title>
<link rel="stylesheet" href="/static/style.css">
<style>
  #app { display: none; }
  #login { max-width: 420px; margin: 64px auto 0; }
  .login-brand { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 6px; }
  .login-brand .brand-dots { grid-template-columns: repeat(3, 9px); grid-template-rows: repeat(2, 9px); gap: 4px; }
  .login-brand .brand-dots span { width: 9px; height: 9px; }
  .login-brand h2 { margin: 0; }
  #form { display: none; }
  .brand-link { text-decoration: none; color: inherit; }
</style>
</head>
<body>

<div class="page page-narrow" id="login">
  <div class="card">
    <div class="login-brand">
      <div class="brand-dots"><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <h2>E-Ink Admin</h2>
    </div>
    <div id="login-message"></div>

    <div class="tabs">
      <div class="tab active" id="tab-login" onclick="switchTab('login')">Log in</div>
      <div class="tab" id="tab-signup" onclick="switchTab('signup')">Create account</div>
    </div>

    <div class="tab-panel active" id="panel-login">
      <p class="hint hint-block">Log in with the passkey you registered for your account. Your browser/OS will show a picker &mdash; there's no username to type.</p>
      <button id="passkey-login-btn">Log in with passkey</button>
    </div>

    <div class="tab-panel" id="panel-signup">
      <p class="hint hint-block">No signup form, no email, no password &mdash; creating an account just means registering a passkey (Face ID, Touch ID, Windows Hello, or a security key). The passkey is the whole account.</p>
      <button id="passkey-signup-btn">Create account with passkey</button>
    </div>

    <details class="api-key-fallback">
      <summary>Use a session token instead</summary>
      <div class="row">
        <label for="api-key-input">Session token</label>
        <input type="password" id="api-key-input" placeholder="eink_...">
      </div>
      <button class="subtle" id="login-btn">Log in with session token</button>
    </details>
  </div>
</div>

<div class="page" id="app">
  <div class="topbar">
    <a class="brand brand-link" href="/">
      <div class="brand-dots"><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <span class="brand-name">E-Ink Admin</span>
    </a>
    <div class="topbar-right">
      <span id="whoami"></span>
      <button class="ghost sm" id="logout-btn">Log out</button>
    </div>
  </div>

  <div id="app-message"></div>
  <div id="claim-banner"></div>
  <div id="join-bucket-banner"></div>
  <div id="assign-bucket-banner"></div>

  <div class="card">
    <div class="card-head">
      <h2>Devices</h2>
      <button class="icon-btn add" id="add-device-btn" aria-label="Set up a new device">+</button>
    </div>
    <p class="hint hint-block">New device? The <strong>+</strong> button takes you to Device Setup, which pairs over Bluetooth and registers it to this account in one step. "Last image sent" below is what the server handed the device on its last successful poll &mdash; e-ink holds whatever it last finished displaying even through power loss, so if a device died mid-refresh (or before one), the physical screen can lag behind this.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Label</th><th>Board</th><th>Last image sent</th><th>Firmware</th><th>Last seen</th><th>Battery</th><th>Buckets</th><th>Schedule</th><th></th></tr></thead>
        <tbody id="devices-table"></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Alerts</h2>
    <p class="hint hint-block">Get a message when a frame stops checking in or its battery runs low. Checked every hour; you get one message when something goes wrong and one when it recovers, never a repeat every hour. Paste an incoming-webhook URL from Discord, Slack, <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a> (a free phone-notification app: any hard-to-guess topic name works), or your own service (Home Assistant, n8n&hellip;), which gets signed JSON.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Format</th><th>Destination</th><th>Last delivery</th><th></th></tr></thead>
        <tbody id="webhooks-table"></tbody>
      </table>
    </div>
    <div class="inline-form" style="margin-top:14px;">
      <div class="row">
        <label for="new-webhook-url">Webhook URL</label>
        <input type="url" id="new-webhook-url" placeholder="https://ntfy.sh/your-secret-topic" maxlength="2048" autocomplete="off" spellcheck="false">
      </div>
      <div class="row">
        <label for="new-webhook-format">Format</label>
        <select id="new-webhook-format">
          <option value="json">JSON (custom)</option>
          <option value="discord">Discord</option>
          <option value="slack">Slack</option>
          <option value="ntfy">ntfy</option>
        </select>
      </div>
      <div class="row">
        <label for="new-webhook-label">Name</label>
        <input type="text" id="new-webhook-label" placeholder="My phone" maxlength="80">
      </div>
      <button id="add-webhook-btn">Add webhook</button>
    </div>
    <div id="webhook-secret"></div>
    <h3 style="margin-top:22px;">Watched frames</h3>
    <p class="hint hint-block">Untick a frame you've unplugged on purpose so it doesn't alert.</p>
    <div id="alert-devices-list"></div>
  </div>

  <div class="modal-overlay" id="register-modal-overlay">
    <div class="modal">
      <div class="card-head">
        <h3>Claim device</h3>
        <button class="icon-btn" id="register-modal-close-btn" aria-label="Close">&#10005;</button>
      </div>
      <p class="hint hint-block">Scan the "scan to register" QR code on an unclaimed device's screen to claim it &mdash; a MAC address alone isn't enough (every board shares the same vendor prefix, so it's guessable). Already own this device? Enter its MAC below to just update its label. Setting up a brand-new device? Use <a href="/provision">Device Setup</a> instead.</p>
      <div class="row">
        <label>MAC address</label>
        <input type="text" id="new-device-mac" placeholder="aabbccddeeff" maxlength="17" autocomplete="off" spellcheck="false">
      </div>
      <div class="row">
        <label>Label</label>
        <input type="text" id="new-device-label" placeholder="Kitchen frame" maxlength="80">
      </div>
      <button id="register-device-btn">Register device</button>
    </div>
  </div>

  <div class="card">
    <h2>Image buckets</h2>
    <p class="hint hint-block">Buckets are independent, shareable photo albums that rotate on the frame. Subscribe a device to any number of them via its "Manage" button above.</p>
    <div class="inline-form">
      <div class="row">
        <label>New bucket name</label>
        <input type="text" id="new-bucket-label" placeholder="Living room rotation" maxlength="80">
      </div>
      <button id="create-bucket-btn">Create bucket</button>
    </div>
    <div class="row checkbox-row" id="new-bucket-public-row" style="display:none; margin-top:10px;">
      <input type="checkbox" id="new-bucket-public-checkbox">
      <label for="new-bucket-public-checkbox" style="margin:0;">Make this public (readable by every account on this server)</label>
    </div>
  </div>
  <h3 id="buckets-mine-heading" style="display:none;">My buckets</h3>
  <div id="buckets-mine"></div>
  <h3 id="buckets-shared-heading" style="display:none; margin-top:26px;">Shared with me</h3>
  <p class="hint hint-block" id="buckets-shared-hint" style="display:none;">Owned by someone else, shared with your account. You can upload and delete photos and assign it to your own devices — only the owner can rename, delete, or manage sharing.</p>
  <div id="buckets-shared"></div>
  <h3 id="buckets-public-heading" style="display:none; margin-top:26px;">Public buckets</h3>
  <p class="hint hint-block" id="buckets-public-hint" style="display:none;">Owned by someone else, but readable by any account. You can view their photos and assign them to your own devices — only the owner can add, delete, rename, or share them.</p>
  <div id="buckets-public"></div>

  <div class="modal-overlay" id="bucket-modal-overlay">
    <div class="modal">
      <h3>Manage buckets</h3>
      <div id="bucket-modal-list"></div>
      <div class="inline-form" style="margin-top:16px;">
        <button id="bucket-modal-save-btn">Save</button>
        <button class="ghost" id="bucket-modal-cancel-btn">Cancel</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="schedule-modal-overlay">
    <div class="modal">
      <h3>Schedule override</h3>
      <div id="schedule-modal-content"></div>
      <div class="inline-form" style="margin-top:16px;">
        <button class="ghost" id="schedule-modal-close-btn">Close</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="rotate-modal-overlay">
    <div class="modal">
      <h3 id="rotate-modal-title">Rotating bucket key</h3>
      <div id="rotate-modal-body"></div>
      <div class="inline-form" style="margin-top:16px;">
        <button class="ghost" id="rotate-modal-close-btn">Close</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="upload-modal-overlay">
    <div class="modal modal-wide">
      <div class="card-head">
        <h3 id="upload-modal-title">Add a photo</h3>
        <button class="icon-btn" id="upload-modal-close-btn" aria-label="Close">&#10005;</button>
      </div>
      <div id="upload-modal-body"></div>
    </div>
  </div>

  <div class="lightbox-overlay" id="lightbox-overlay">
    <button class="icon-btn lightbox-close" id="lightbox-close-btn" aria-label="Close">&#10005;</button>
    <div class="lightbox-body">
      <div id="lightbox-content"></div>
      <div class="lightbox-caption" id="lightbox-caption"></div>
    </div>
  </div>

  <div class="card accordion" id="firmware-accordion">
    <div class="card-head accordion-toggle" onclick="toggleAccordion('firmware-accordion')">
      <div>
        <h2>Firmware (OTA)</h2>
        <p class="hint" style="margin:2px 0 0;">Releases, update channels, and crash reports</p>
      </div>
      <span class="chevron">&#9662;</span>
    </div>
    <div class="accordion-body" id="firmware-accordion-body">
      <p class="hint hint-block">Devices on the "stable" channel always run whichever release below was synced most recently for their own board &mdash; there's no picking a specific version. "beta" doesn't do anything yet (no beta channel exists).</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Board</th><th>Version</th><th>Tag</th><th>Size</th><th>SHA-256</th><th>Synced</th></tr></thead>
          <tbody id="firmware-releases-table"></tbody>
        </table>
      </div>
      <div class="inline-form" style="margin-top:14px;">
        <button class="subtle" id="firmware-sync-btn">Sync from GitHub</button>
        <span class="hint">Also runs automatically every 6 hours.</span>
      </div>

      <h3 style="margin-top:26px;">Channels</h3>
      <p class="hint hint-block">Each device only ever updates when a channel is set for its own MAC &mdash; there's no shared fallback. Clearing a device's channel leaves it on whatever it's already running.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Target</th><th>Channel</th><th>Updated</th><th></th></tr></thead>
          <tbody id="firmware-targets-table"></tbody>
        </table>
      </div>
      <div class="inline-form" style="margin-top:14px;">
        <div class="row">
          <label>Target</label>
          <select id="firmware-target-select"></select>
        </div>
        <div class="row">
          <label>Channel</label>
          <select id="firmware-channel-select">
            <option value="stable">stable</option>
            <option value="beta">beta (no-op for now)</option>
          </select>
        </div>
        <button id="firmware-target-save-btn">Set channel</button>
      </div>

      <h3 style="margin-top:26px;">Crash &amp; rollback reports</h3>
      <p class="hint hint-block">Filled in automatically when a device panics, watchdog-resets, or an OTA gets rolled back after failing to confirm itself healthy. Backtrace entries are raw program-counter addresses from the on-device core dump &mdash; symbolize them against a matching .elf build for more than the version/reason.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Device</th><th>Version</th><th>Reason</th><th>Rolled back</th><th>Backtrace</th><th>Received</th></tr></thead>
          <tbody id="crash-reports-table"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>Sessions</h3>
    <p class="hint hint-block">Each browser login creates its own session. Signing out other devices revokes their tokens immediately; this browser stays logged in.</p>
    <button class="ghost" id="rotate-key-btn">Sign out other devices</button>
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
