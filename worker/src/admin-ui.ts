/**
 * Self-contained admin single-page app: no build step, vanilla JS, calls the
 * JSON admin API (Authorization: Bearer <api_key>) client-side. The API key is
 * kept in localStorage only — this route itself serves no secrets and needs no
 * server-side auth. Accounts are created and re-authenticated via a passkey
 * ceremony (see routes/auth-passkey.ts); a successful ceremony just mints an
 * API key, which is then used exactly like any Bearer-token API client.
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
    display: none; position: absolute; z-index: 30; top: 0; left: 55px;
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
  .bucket-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
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

  <div class="card">
    <h2>Devices</h2>
    <table>
      <thead><tr><th>MAC</th><th>Label</th><th>Last seen</th><th>Battery</th><th>Default images</th><th></th></tr></thead>
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
    <h3>Global fallback schedule</h3>
    <p class="hint">Used when a device has no schedule override of its own.</p>
    <div id="bucket-global"></div>
  </div>

  <h2>Image Buckets</h2>
  <div class="bucket-grid" id="buckets"></div>

  <div class="card">
    <h3>API Key</h3>
    <p class="hint">Rotating your key immediately invalidates the old one — anything using it (scripts, the firmware config page) will need the new value.</p>
    <button class="ghost" id="rotate-key-btn">Rotate API Key</button>
  </div>
</div>

<script>
const KEY_STORAGE = "eink_admin_api_key";
const DITHER_ALGORITHMS = ["floyd_steinberg", "atkinson", "ordered"];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getApiKey() { return localStorage.getItem(KEY_STORAGE); }
function setApiKey(key) { localStorage.setItem(KEY_STORAGE, key); }
function clearApiKey() { localStorage.removeItem(KEY_STORAGE); }

async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers, { Authorization: "Bearer " + getApiKey() });
  const res = await fetch(path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    let message = res.status + " " + res.statusText;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json") ? res.json() : res.text();
}

function showMessage(elId, text, kind) {
  const el = document.getElementById(elId);
  el.innerHTML = text ? '<div class="message ' + kind + '">' + escapeHtml(text) + "</div>" : "";
}

async function publicFetch(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (res.status + " " + res.statusText));
  return data;
}

function switchTab(name) {
  showMessage("login-message", "", "");
  for (const tab of ["login", "signup"]) {
    document.getElementById("tab-" + tab).classList.toggle("active", tab === name);
    document.getElementById("panel-" + tab).classList.toggle("active", tab === name);
  }
}
window.switchTab = switchTab;

function passkeysSupported() {
  return !!(window.PublicKeyCredential && PublicKeyCredential.parseCreationOptionsFromJSON && PublicKeyCredential.parseRequestOptionsFromJSON);
}

document.getElementById("passkey-signup-btn").addEventListener("click", async () => {
  if (!passkeysSupported()) {
    showMessage("login-message", "This browser doesn't support passkeys. Try an up-to-date Chrome, Safari, or Firefox.", "error");
    return;
  }
  try {
    const { attemptId, options } = await publicFetch("/auth/register/options", {});
    const creationOptions = PublicKeyCredential.parseCreationOptionsFromJSON(options);
    const credential = await navigator.credentials.create({ publicKey: creationOptions });
    const result = await publicFetch("/auth/register/verify", { attemptId, response: credential.toJSON() });
    setApiKey(result.api_key);
    alert("Account created! Your API key (also saved to this browser, shown once):\\n\\n" + result.api_key);
    await tryLogin(true);
  } catch (err) {
    showMessage("login-message", "Failed to create account: " + err.message, "error");
  }
});

document.getElementById("passkey-login-btn").addEventListener("click", async () => {
  if (!passkeysSupported()) {
    showMessage("login-message", "This browser doesn't support passkeys. Try an up-to-date Chrome, Safari, or Firefox, or use an API key below.", "error");
    return;
  }
  try {
    const { attemptId, options } = await publicFetch("/auth/login/options", {});
    const requestOptions = PublicKeyCredential.parseRequestOptionsFromJSON(options);
    const credential = await navigator.credentials.get({ publicKey: requestOptions });
    const result = await publicFetch("/auth/login/verify", { attemptId, response: credential.toJSON() });
    setApiKey(result.api_key);
    await tryLogin(true);
  } catch (err) {
    showMessage("login-message", "Failed to log in: " + err.message, "error");
  }
});

async function tryLogin(showError) {
  const key = getApiKey();
  if (!key) return false;
  try {
    const me = await apiFetch("/admin/me");
    document.getElementById("whoami").textContent = "Account " + me.id.slice(0, 8);
    document.getElementById("login").style.display = "none";
    document.getElementById("app").style.display = "block";
    await renderApp();
    return true;
  } catch (err) {
    if (showError) showMessage("login-message", "Invalid API key: " + err.message, "error");
    clearApiKey();
    return false;
  }
}

document.getElementById("login-btn").addEventListener("click", async () => {
  const key = document.getElementById("api-key-input").value.trim();
  if (!key) return;
  setApiKey(key);
  await tryLogin(true);
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearApiKey();
  document.getElementById("app").style.display = "none";
  document.getElementById("login").style.display = "block";
});

document.getElementById("rotate-key-btn").addEventListener("click", async () => {
  if (!confirm("Rotate your API key? The old key stops working immediately.")) return;
  try {
    const result = await apiFetch("/admin/keys/rotate", { method: "POST" });
    setApiKey(result.api_key);
    alert("New API key (also saved to this browser):\\n\\n" + result.api_key);
  } catch (err) {
    showMessage("app-message", "Failed to rotate key: " + err.message, "error");
  }
});

document.getElementById("register-device-btn").addEventListener("click", async () => {
  const mac = document.getElementById("new-device-mac").value.trim();
  const label = document.getElementById("new-device-label").value.trim();
  if (!mac) return;
  try {
    await apiFetch("/admin/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac, label }),
    });
    document.getElementById("new-device-mac").value = "";
    document.getElementById("new-device-label").value = "";
    if (new URLSearchParams(location.search).get("claim")) {
      history.replaceState(null, "", location.pathname);
    }
    await renderApp();
  } catch (err) {
    showMessage("app-message", "Failed to register device: " + err.message, "error");
  }
});

async function deleteDevice(mac) {
  if (!confirm("Unregister device " + mac + "? Its images stay in place but the MAC falls back to the default bucket.")) return;
  try {
    await apiFetch("/admin/devices/" + encodeURIComponent(mac), { method: "DELETE" });
    await renderApp();
  } catch (err) {
    showMessage("app-message", "Failed to delete device: " + err.message, "error");
  }
}
window.deleteDevice = deleteDevice;

async function toggleIncludeDefaultImages(mac, checked) {
  try {
    await apiFetch("/admin/devices/" + encodeURIComponent(mac), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include_default_images: checked }),
    });
    await renderApp();
  } catch (err) {
    showMessage("app-message", "Failed to update " + mac + ": " + err.message, "error");
  }
}
window.toggleIncludeDefaultImages = toggleIncludeDefaultImages;

function renderDevicesTable(devices) {
  const tbody = document.getElementById("devices-table");
  if (devices.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint">No devices registered yet.</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map((d) => {
    const battery = d.last_battery_voltage != null
      ? d.last_battery_voltage.toFixed(2) + "V"
      : '<span class="hint">n/a</span>';
    const lastSeen = d.last_seen_at
      ? new Date(d.last_seen_at * 1000).toLocaleString() + (d.last_seen_ip ? " (" + escapeHtml(d.last_seen_ip) + ")" : "")
      : '<span class="hint">never</span>';
    return "<tr>" +
      "<td><code>" + escapeHtml(d.mac) + "</code></td>" +
      "<td>" + escapeHtml(d.label || "") + "</td>" +
      "<td>" + lastSeen + "</td>" +
      "<td>" + battery + "</td>" +
      '<td><input type="checkbox" ' + (d.include_default_images ? "checked" : "") +
        ' onchange="toggleIncludeDefaultImages(\\'' + escapeHtml(d.mac) + '\\', this.checked)"></td>' +
      '<td><button class="danger" onclick="deleteDevice(\\'' + escapeHtml(d.mac) + '\\')">Remove</button></td>' +
      "</tr>";
  }).join("");
}

function scheduleFormHtml(target, override) {
  const v = override || {};
  const has = !!override;
  return (
    '<div class="inline-form">' +
      '<div class="row"><label>Refresh (min)</label><input type="number" min="1" max="1440" id="sched-refresh-' + target + '" value="' + (v.refresh_interval_minutes ?? 60) + '"></div>' +
      '<div class="row"><label>Active start hr</label><input type="number" min="0" max="23" id="sched-start-' + target + '" value="' + (v.active_start_hour ?? 8) + '"></div>' +
      '<div class="row"><label>Active end hr</label><input type="number" min="0" max="23" id="sched-end-' + target + '" value="' + (v.active_end_hour ?? 20) + '"></div>' +
      '<div class="row"><label>TZ offset (min)</label><input type="number" min="-720" max="840" id="sched-tz-' + target + '" value="' + (v.timezone_offset_minutes ?? 0) + '"></div>' +
    "</div>" +
    '<div class="inline-form" style="margin-top:10px;">' +
      '<button onclick="saveSchedule(\\'' + target + '\\')">Save</button>' +
      (has ? '<button class="ghost" onclick="clearSchedule(\\'' + target + '\\')">Clear override</button>' : "") +
      '<span class="hint">' + (has ? "Override active" : "No override — falls back to the next tier") + "</span>" +
    "</div>"
  );
}

async function saveSchedule(target) {
  const body = {
    refresh_interval_minutes: Number(document.getElementById("sched-refresh-" + target).value),
    active_start_hour: Number(document.getElementById("sched-start-" + target).value),
    active_end_hour: Number(document.getElementById("sched-end-" + target).value),
    timezone_offset_minutes: Number(document.getElementById("sched-tz-" + target).value),
  };
  try {
    await apiFetch("/admin/schedule/" + encodeURIComponent(target), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await renderApp();
  } catch (err) {
    showMessage("app-message", "Failed to save schedule for " + target + ": " + err.message, "error");
  }
}
window.saveSchedule = saveSchedule;

async function clearSchedule(target) {
  try {
    await apiFetch("/admin/schedule/" + encodeURIComponent(target), { method: "DELETE" });
    await renderApp();
  } catch (err) {
    showMessage("app-message", "Failed to clear schedule for " + target + ": " + err.message, "error");
  }
}
window.clearSchedule = clearSchedule;

const fullImageUrlCache = {};

// Lazy-loaded on first hover (the raw endpoint re-checks ownership per request,
// so there's no point prefetching every thumbnail's full image up front). Cached
// by object URL per image id so repeat hovers in the same session are instant.
async function loadFullImage(id) {
  const popup = document.getElementById("full-" + id);
  if (!popup || popup.dataset.loaded) return;
  if (fullImageUrlCache[id]) {
    popup.innerHTML = '<img src="' + fullImageUrlCache[id] + '" alt="">';
    popup.dataset.loaded = "1";
    return;
  }
  try {
    const res = await fetch("/admin/images/" + encodeURIComponent(id) + "/raw", {
      headers: { Authorization: "Bearer " + getApiKey() },
    });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    fullImageUrlCache[id] = url;
    popup.innerHTML = '<img src="' + url + '" alt="">';
    popup.dataset.loaded = "1";
  } catch (err) {
    popup.innerHTML = '<p class="hint">Failed to load: ' + escapeHtml(err.message) + "</p>";
  }
}
window.loadFullImage = loadFullImage;

async function deleteImage(id) {
  if (!confirm("Delete this image? This cannot be undone.")) return;
  try {
    await apiFetch("/admin/images/" + encodeURIComponent(id), { method: "DELETE" });
    await renderApp();
  } catch (err) {
    showMessage("app-message", "Failed to delete image: " + err.message, "error");
  }
}
window.deleteImage = deleteImage;

async function uploadImage(deviceKey) {
  const fileInput = document.getElementById("upload-file-" + deviceKey);
  const filenameInput = document.getElementById("upload-filename-" + deviceKey);
  const ditherSelect = document.getElementById("upload-dither-" + deviceKey);
  const file = fileInput.files[0];
  if (!file) { showMessage("app-message", "Choose a file first.", "error"); return; }
  const filename = (filenameInput.value || file.name).trim();
  const dither = ditherSelect.value;

  try {
    await apiFetch(
      "/admin/images/upload?device_key=" + encodeURIComponent(deviceKey) +
      "&filename=" + encodeURIComponent(filename) +
      "&dither=" + encodeURIComponent(dither),
      { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file }
    );
    fileInput.value = "";
    filenameInput.value = "";
    await renderApp();
  } catch (err) {
    showMessage("app-message", "Failed to upload image: " + err.message, "error");
  }
}
window.uploadImage = uploadImage;

function bucketCardHtml(deviceKey, label, images, override) {
  const rows = images.length
    ? images.map((img) =>
        "<tr>" +
        "<td>" + (img.thumbnail_data_url
          ? '<div class="thumb-wrap" onmouseenter="loadFullImage(\\'' + img.id + '\\')">' +
              '<img class="thumb" src="' + img.thumbnail_data_url + '" alt="" width="45" height="60">' +
              '<div class="thumb-popup" id="full-' + img.id + '"><p class="hint">Loading…</p></div>' +
            "</div>"
          : '<span class="hint">n/a</span>') + "</td>" +
        "<td><code>" + escapeHtml(img.filename) + "</code></td>" +
        '<td><span class="pill">' + escapeHtml(img.dither_algorithm) + "</span></td>" +
        "<td>" + new Date(img.created_at * 1000).toLocaleDateString() + "</td>" +
        '<td><button class="danger" onclick="deleteImage(\\'' + img.id + '\\')">Delete</button></td>' +
        "</tr>"
      ).join("")
    : '<tr><td colspan="5" class="hint">No images yet.</td></tr>';

  const ditherOptions = DITHER_ALGORITHMS.map((a) => '<option value="' + a + '">' + a + "</option>").join("");

  return (
    '<div class="card">' +
      "<h3>" + escapeHtml(label) + "</h3>" +
      "<table><thead><tr><th></th><th>Filename</th><th>Dither</th><th>Uploaded</th><th></th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>" +
      '<div class="inline-form" style="margin-top:12px;">' +
        '<div class="row"><label>Image file</label><input type="file" id="upload-file-' + deviceKey + '" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"></div>' +
        '<div class="row"><label>Filename</label><input type="text" id="upload-filename-' + deviceKey + '" placeholder="(from file)"></div>' +
        '<div class="row"><label>Dither</label><select id="upload-dither-' + deviceKey + '">' + ditherOptions + "</select></div>" +
        '<button onclick="uploadImage(\\'' + deviceKey + '\\')">Upload</button>' +
      "</div>" +
      '<h4 style="margin-top:18px;">Schedule override</h4>' +
      scheduleFormHtml(deviceKey, override) +
    "</div>"
  );
}

function renderClaimBanner() {
  const claimMac = new URLSearchParams(location.search).get("claim");
  const el = document.getElementById("claim-banner");
  if (!claimMac) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    '<div class="message success">' +
    "Scanned from a new device: <code>" + escapeHtml(claimMac) + "</code>. " +
    "Enter a label below and click Register to add it to your account." +
    "</div>";
  document.getElementById("new-device-mac").value = claimMac;
  document.getElementById("new-device-label").focus();
}

async function renderApp() {
  showMessage("app-message", "", "");
  renderClaimBanner();
  const [devicesResult, globalSchedule] = await Promise.all([
    apiFetch("/admin/devices"),
    apiFetch("/admin/schedule/global"),
  ]);
  const devices = devicesResult.devices;
  renderDevicesTable(devices);
  document.getElementById("bucket-global").innerHTML = scheduleFormHtml("global", globalSchedule.override);

  const buckets = [{ key: "default", label: "default (unregistered / fallback devices)" }].concat(
    devices.map((d) => ({ key: d.mac, label: (d.label || d.mac) + " (" + d.mac + ")" }))
  );

  const bucketsEl = document.getElementById("buckets");
  bucketsEl.innerHTML = buckets.map((b) => '<div id="bucket-' + b.key + '"></div>').join("");

  await Promise.all(buckets.map(async (b) => {
    const [imagesResult, scheduleResult] = await Promise.all([
      apiFetch("/admin/images?device_key=" + encodeURIComponent(b.key)),
      apiFetch("/admin/schedule/" + encodeURIComponent(b.key)),
    ]);
    document.getElementById("bucket-" + b.key).innerHTML =
      bucketCardHtml(b.key, b.label, imagesResult.images, scheduleResult.override);
  }));
}

tryLogin(false);
</script>
</body>
</html>`;
}
