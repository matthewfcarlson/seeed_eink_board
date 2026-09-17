/**
 * Client-side script for the admin single-page app (see ../admin-ui.ts). Bundled
 * by scripts/build-client.mjs into public/static/admin.js and served as a static
 * asset — this file is real, type-checked TypeScript rather than a hand-escaped
 * string embedded in the worker.
 */
export {};

import {
  HKDF_INFO_BUCKET_WRAP,
  aesGcmDecryptBlob,
  aesGcmDecryptFromStrings,
  aesGcmEncryptBlob,
  aesGcmEncryptToStrings,
  deriveKekFromPrf,
  exportAesKeyRaw,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  fromBase64,
  fromBase64Url,
  generateBucketKey,
  generateP256KeyPair,
  importAesKeyRaw,
  importPrivateKeyPkcs8,
  toBase64,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyFor,
  type WrappedKey,
} from "./crypto";
import { decodeToLandscapeBuffer } from "./decode";
import { computeHash16, ditherImage, enhance, packToNibbles } from "../lib/dither";
import type { DitherAlgorithm } from "../lib/media-constants";
import { makeThumbnailJpeg } from "./thumbnail";
import { localKeystoreGet, localKeystoreSet } from "./keystore";

const KEY_STORAGE = "eink_admin_api_key";
const DITHER_ALGORITHMS = ["floyd_steinberg", "atkinson", "ordered"];
const DEFAULT_BRIGHTNESS = 1.0;
const DEFAULT_CONTRAST = 1.2;
const DEFAULT_SATURATION = 1.2;
// Set by renderClaimBanner() from ?secret= when arriving via a device's QR scan;
// consumed once by the Register click handler. See lib/registration-url.ts.
let pendingClaimSecret: string | null = null;
let currentUser: any = null;
let devicesCache: any[] = [];
let allBucketsCache: any[] = [];
let bucketModalMac: string | null = null;

// This browser's unwrapped view of the current user's sharing keypair (see
// root CLAUDE.md's encrypted-buckets plan) — recovered fresh on every login
// via WebAuthn PRF, or (no-PRF authenticator) restored from keystore.ts.
// Null means this session can't decrypt any bucket: either not logged in via
// a passkey ceremony yet, or this authenticator has no PRF result and no
// local key was ever established.
let sharingPrivateKey: CryptoKey | null = null;
let sharingPublicKeyRaw: Uint8Array | null = null;
// bucketId -> that bucket's unwrapped AES-256-GCM content key, populated by
// renderApp() from each bucket's caller-specific WrappedKey.
const bucketAesKeys = new Map<string, CryptoKey>();

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c] ?? c);
}

// Single-cell LiPo range this board's battery circuit is calibrated for (see
// CLAUDE.md's Battery Monitoring section). Percent is derived at render time
// from the voltage already stored — not sent by the firmware separately, so
// there's one source of truth to keep in sync.
const BATTERY_VOLTAGE_FULL = 4.1;
const BATTERY_VOLTAGE_EMPTY = 3.2;
function batteryPercent(voltage: number): number {
  const percent = Math.round(
    ((voltage - BATTERY_VOLTAGE_EMPTY) / (BATTERY_VOLTAGE_FULL - BATTERY_VOLTAGE_EMPTY)) * 100
  );
  return Math.max(0, Math.min(100, percent));
}

function getApiKey(): string | null { return localStorage.getItem(KEY_STORAGE); }
function setApiKey(key: string) { localStorage.setItem(KEY_STORAGE, key); }
function clearApiKey() { localStorage.removeItem(KEY_STORAGE); }

async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
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

function showMessage(elId: string, text: string, kind: string) {
  el(elId).innerHTML = text ? '<div class="message ' + kind + '">' + escapeHtml(text) + "</div>" : "";
}

async function publicFetch(path: string, body: any): Promise<any> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (res.status + " " + res.statusText));
  return data;
}

function switchTab(name: string) {
  showMessage("login-message", "", "");
  for (const tab of ["login", "signup"]) {
    el("tab-" + tab).classList.toggle("active", tab === name);
    el("panel-" + tab).classList.toggle("active", tab === name);
  }
}
(window as any).switchTab = switchTab;

function passkeysSupported(): boolean {
  const PKC = (window as any).PublicKeyCredential;
  return !!(PKC && PKC.parseCreationOptionsFromJSON && PKC.parseRequestOptionsFromJSON);
}

/** Reads this ceremony's WebAuthn PRF result, if the authenticator returned
 *  one — undefined otherwise (older security keys, unsupported platforms). */
function readPrfOutput(credential: any): ArrayBuffer | undefined {
  const results = credential.getClientExtensionResults?.();
  return results?.prf?.results?.first;
}

/** Called once, right after a successful registration ceremony: generates
 *  this account's sharing keypair and, if this ceremony's authenticator
 *  supports PRF, wraps the private key for upload alongside the registration
 *  verify call. Otherwise the keypair is stashed in this browser's IndexedDB
 *  only (see keystore.ts) — sharing_public_key stays null server-side until a
 *  later login backfills it (see completeLoginSharingKey below), so this
 *  account can't yet be shared *into* buckets by others from this state.
 *  Populates the module-level sharingPrivateKey/sharingPublicKeyRaw either way. */
async function completeRegistrationSharingKey(
  credential: any
): Promise<Partial<{ sharing_public_key: string; wrapped_sharing_key: string; wrap_nonce: string }>> {
  const keyPair = await generateP256KeyPair();
  sharingPrivateKey = keyPair.privateKey;
  sharingPublicKeyRaw = await exportPublicKeyRaw(keyPair.publicKey);
  const privateKeyPkcs8 = await exportPrivateKeyPkcs8(keyPair.privateKey);

  const prfOutput = readPrfOutput(credential);
  if (!prfOutput) {
    await localKeystoreSet({ publicKeyRaw: sharingPublicKeyRaw, privateKeyPkcs8 });
    return {};
  }
  const kek = await deriveKekFromPrf(prfOutput);
  const { nonce, ciphertext } = await aesGcmEncryptToStrings(kek, privateKeyPkcs8);
  return { sharing_public_key: toBase64(sharingPublicKeyRaw), wrapped_sharing_key: ciphertext, wrap_nonce: nonce };
}

/** Called once, right after a successful login ceremony, with that ceremony's
 *  credential (for its PRF output) and the /auth/login/verify response (for
 *  whatever's already wrapped server-side). Recovers this session's sharing
 *  keypair from whichever source is available, and returns fields to
 *  backfill server-side only when that's newly possible this time (see
 *  routes/auth-passkey.ts's IS NULL guards — sending these when a wrap
 *  already exists is harmless, just redundant). */
async function completeLoginSharingKey(
  credential: any,
  loginResult: any
): Promise<Partial<{ sharing_public_key: string; wrapped_sharing_key: string; wrap_nonce: string }>> {
  const prfOutput = readPrfOutput(credential);

  if (loginResult.wrapped_sharing_key && loginResult.sharing_public_key && prfOutput) {
    const kek = await deriveKekFromPrf(prfOutput);
    const privateKeyPkcs8 = await aesGcmDecryptFromStrings(kek, loginResult.wrap_nonce, loginResult.wrapped_sharing_key);
    sharingPrivateKey = await importPrivateKeyPkcs8(privateKeyPkcs8);
    sharingPublicKeyRaw = fromBase64(loginResult.sharing_public_key);
    return {};
  }

  // No usable PRF-wrapped key from the server this time (either none exists
  // yet, or this ceremony didn't yield a PRF result) — fall back to whatever
  // this browser has cached locally.
  const local = await localKeystoreGet();
  if (local) {
    sharingPrivateKey = await importPrivateKeyPkcs8(local.privateKeyPkcs8);
    sharingPublicKeyRaw = local.publicKeyRaw;
    if (prfOutput && !loginResult.wrapped_sharing_key) {
      // First time this credential has produced PRF output — backfill the
      // server with our existing local key instead of generating a new one.
      const kek = await deriveKekFromPrf(prfOutput);
      const { nonce, ciphertext } = await aesGcmEncryptToStrings(kek, local.privateKeyPkcs8);
      return { sharing_public_key: toBase64(local.publicKeyRaw), wrapped_sharing_key: ciphertext, wrap_nonce: nonce };
    }
    return {};
  }

  // No server key and no local key — shouldn't normally happen (registration
  // always establishes one somewhere) but degrade gracefully rather than
  // leave sharingPrivateKey null: generate fresh, same as a first registration.
  const keyPair = await generateP256KeyPair();
  sharingPrivateKey = keyPair.privateKey;
  sharingPublicKeyRaw = await exportPublicKeyRaw(keyPair.publicKey);
  const privateKeyPkcs8 = await exportPrivateKeyPkcs8(keyPair.privateKey);
  if (prfOutput) {
    const kek = await deriveKekFromPrf(prfOutput);
    const { nonce, ciphertext } = await aesGcmEncryptToStrings(kek, privateKeyPkcs8);
    return { sharing_public_key: toBase64(sharingPublicKeyRaw), wrapped_sharing_key: ciphertext, wrap_nonce: nonce };
  }
  await localKeystoreSet({ publicKeyRaw: sharingPublicKeyRaw, privateKeyPkcs8 });
  return {};
}

el("passkey-signup-btn").addEventListener("click", async () => {
  if (!passkeysSupported()) {
    showMessage("login-message", "This browser doesn't support passkeys. Try an up-to-date Chrome, Safari, or Firefox.", "error");
    return;
  }
  try {
    const { attemptId, options } = await publicFetch("/auth/register/options", {});
    const creationOptions = (window as any).PublicKeyCredential.parseCreationOptionsFromJSON(options);
    const credential: any = await navigator.credentials.create({ publicKey: creationOptions });
    const sharingKeyFields = await completeRegistrationSharingKey(credential);
    const result = await publicFetch("/auth/register/verify", {
      attemptId,
      response: credential.toJSON(),
      ...sharingKeyFields,
    });
    setApiKey(result.api_key);
    alert("Account created! Your API key (also saved to this browser, shown once):\n\n" + result.api_key);
    await tryLogin(true);
  } catch (err: any) {
    showMessage("login-message", "Failed to create account: " + err.message, "error");
  }
});

el("passkey-login-btn").addEventListener("click", async () => {
  if (!passkeysSupported()) {
    showMessage("login-message", "This browser doesn't support passkeys. Try an up-to-date Chrome, Safari, or Firefox, or use an API key below.", "error");
    return;
  }
  try {
    const { attemptId, options } = await publicFetch("/auth/login/options", {});
    const requestOptions = (window as any).PublicKeyCredential.parseRequestOptionsFromJSON(options);
    const credential: any = await navigator.credentials.get({ publicKey: requestOptions });
    const loginResult = await publicFetch("/auth/login/verify", { attemptId, response: credential.toJSON() });
    setApiKey(loginResult.api_key);
    const backfillFields = await completeLoginSharingKey(credential, loginResult);
    if (Object.keys(backfillFields).length > 0) {
      // Separate authenticated call, not another /auth/login/verify — that
      // ceremony's challenge is single-use and was already consumed by the
      // call above. Best-effort: a failure here just means we try again next
      // login, same as if PRF hadn't been available yet at all.
      apiFetch("/admin/me/sharing-key", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential_id: credential.id, ...backfillFields }),
      }).catch(() => {});
    }
    await tryLogin(true);
  } catch (err: any) {
    showMessage("login-message", "Failed to log in: " + err.message, "error");
  }
});

function renderWhoami() {
  el("whoami").textContent = currentUser.display_name
    ? "Howdy " + currentUser.display_name
    : "Account " + currentUser.id.slice(0, 8);
}

async function tryLogin(showError: boolean): Promise<boolean> {
  const key = getApiKey();
  if (!key) return false;
  try {
    currentUser = await apiFetch("/admin/me");
    renderWhoami();
    el("login").style.display = "none";
    el("app").style.display = "block";
    await renderApp();
    return true;
  } catch (err: any) {
    if (showError) showMessage("login-message", "Invalid API key: " + err.message, "error");
    clearApiKey();
    return false;
  }
}

el("edit-name-btn").addEventListener("click", async () => {
  const next = prompt("Display name:", (currentUser && currentUser.display_name) || "");
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  try {
    currentUser = await apiFetch("/admin/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: trimmed }),
    });
    renderWhoami();
  } catch (err: any) {
    showMessage("app-message", "Failed to update name: " + err.message, "error");
  }
});

el("login-btn").addEventListener("click", async () => {
  const key = el<HTMLInputElement>("api-key-input").value.trim();
  if (!key) return;
  setApiKey(key);
  await tryLogin(true);
});

el("logout-btn").addEventListener("click", () => {
  clearApiKey();
  el("app").style.display = "none";
  el("login").style.display = "block";
});

el("rotate-key-btn").addEventListener("click", async () => {
  if (!confirm("Rotate your API key? The old key stops working immediately.")) return;
  try {
    const result = await apiFetch("/admin/keys/rotate", { method: "POST" });
    setApiKey(result.api_key);
    alert("New API key (also saved to this browser):\n\n" + result.api_key);
  } catch (err: any) {
    showMessage("app-message", "Failed to rotate key: " + err.message, "error");
  }
});

el("register-device-btn").addEventListener("click", async () => {
  const mac = el<HTMLInputElement>("new-device-mac").value.trim();
  const label = el<HTMLInputElement>("new-device-label").value.trim();
  if (!mac) return;
  try {
    const body: any = { mac, label };
    // Only attach the secret when this MAC is exactly the one it was scanned for —
    // guards against silently binding a stale secret if the user edits the MAC
    // field after scanning (or types one in by hand).
    if (pendingClaimSecret && mac === new URLSearchParams(location.search).get("claim")) {
      body.secret = pendingClaimSecret;
    }
    await apiFetch("/admin/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    el<HTMLInputElement>("new-device-mac").value = "";
    el<HTMLInputElement>("new-device-label").value = "";
    if (new URLSearchParams(location.search).get("claim")) {
      pendingClaimSecret = null;
      history.replaceState(null, "", location.pathname);
    }
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to register device: " + err.message, "error");
  }
});

async function deleteDevice(mac: string) {
  if (!confirm(`Unregister device ${mac}? Its images stay in place but the MAC will show a "scan to register" QR code until re-claimed.`)) return;
  try {
    await apiFetch("/admin/devices/" + encodeURIComponent(mac), { method: "DELETE" });
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to delete device: " + err.message, "error");
  }
}
(window as any).deleteDevice = deleteDevice;

function bucketLabelsFor(bucketIds: string[] | undefined): string {
  if (!bucketIds || bucketIds.length === 0) return '<span class="hint">none</span>';
  return bucketIds
    .map((id) => {
      const b = allBucketsCache.find((x) => x.id === id);
      return escapeHtml(b ? b.label : id);
    })
    .join(", ");
}

function openBucketModal(mac: string) {
  bucketModalMac = mac;
  const device = devicesCache.find((d) => d.mac === mac);
  const currentBucketIds = device ? device.bucket_ids : [];
  const list = el("bucket-modal-list");
  list.innerHTML = allBucketsCache.length
    ? '<div class="bucket-checkbox-list">' +
      allBucketsCache
        .map(
          (b) =>
            '<label><input type="checkbox" value="' + escapeHtml(b.id) + '" ' +
            (currentBucketIds.includes(b.id) ? "checked" : "") + "> " + escapeHtml(b.label) + "</label>"
        )
        .join("") +
      "</div>"
    : '<p class="hint">No buckets yet — create one in the Image Buckets section first.</p>';
  el("bucket-modal-overlay").classList.add("open");
}
(window as any).openBucketModal = openBucketModal;

el("bucket-modal-cancel-btn").addEventListener("click", () => {
  el("bucket-modal-overlay").classList.remove("open");
});

el("bucket-modal-save-btn").addEventListener("click", async () => {
  const checked = Array.from(document.querySelectorAll<HTMLInputElement>("#bucket-modal-list input[type=checkbox]:checked")).map(
    (input) => input.value
  );
  const device = devicesCache.find((d) => d.mac === bucketModalMac);
  if (!device?.sharing_public_key) {
    showMessage("app-message", "This device hasn't reported a sharing key yet — update its firmware and let it check in first.", "error");
    return;
  }
  const devicePublicKeyRaw = fromBase64(device.sharing_public_key);

  try {
    // Wrap every selected bucket's key for this device — the Worker can't do
    // this itself, so the browser (which already holds each bucket's raw key,
    // being allowed to assign it) does it before saving.
    const keys: Record<string, WrappedKey> = {};
    for (const bucketId of checked) {
      const bucketKey = bucketAesKeys.get(bucketId);
      if (!bucketKey) throw new Error(`bucket ${bucketId}'s key isn't unlocked in this session`);
      const rawKey = await exportAesKeyRaw(bucketKey);
      keys[bucketId] = await wrapKeyFor(devicePublicKeyRaw, rawKey, HKDF_INFO_BUCKET_WRAP);
    }

    await apiFetch("/admin/devices/" + encodeURIComponent(bucketModalMac as string) + "/buckets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket_ids: checked, keys }),
    });
    el("bucket-modal-overlay").classList.remove("open");
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to save buckets: " + err.message, "error");
  }
});

async function openScheduleModal(mac: string) {
  const content = el("schedule-modal-content");
  content.innerHTML = '<p class="hint">Loading…</p>';
  el("schedule-modal-overlay").classList.add("open");
  try {
    const result = await apiFetch("/admin/schedule/" + encodeURIComponent(mac));
    content.innerHTML = scheduleFormHtml(mac, result.override);
  } catch (err: any) {
    content.innerHTML = '<p class="hint">Failed to load schedule: ' + escapeHtml(err.message) + "</p>";
  }
}
(window as any).openScheduleModal = openScheduleModal;

el("schedule-modal-close-btn").addEventListener("click", () => {
  el("schedule-modal-overlay").classList.remove("open");
});

// "Uptime" here means wall-clock time since the device's row was first created
// (its initial registration/provisioning), not continuous runtime — the board
// deep-sleeps between wake cycles, so there's no meaningful "time since last boot".
function formatUptime(createdAtSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAtSeconds);
  const days = Math.floor(seconds / 86400);
  if (days > 0) {
    const hours = Math.floor((seconds % 86400) / 3600);
    return days + "d" + (hours > 0 ? " " + hours + "h" : "");
  }
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) {
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours + "h" + (minutes > 0 ? " " + minutes + "m" : "");
  }
  return Math.floor(seconds / 60) + "m";
}

function renderDevicesTable(devices: any[]) {
  const tbody = el("devices-table");
  if (devices.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="hint">No devices registered yet.</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map((d) => {
    const battery = d.last_battery_voltage != null
      ? d.last_battery_voltage.toFixed(2) + "V (" + batteryPercent(d.last_battery_voltage) + "%)"
      : '<span class="hint">n/a</span>';
    const lastSeen = d.last_seen_at
      ? new Date(d.last_seen_at * 1000).toLocaleString() + (d.last_seen_ip ? " (" + escapeHtml(d.last_seen_ip) + ")" : "")
      : '<span class="hint">never</span>';
    const firmware = d.running_firmware_version
      ? escapeHtml(d.running_firmware_version)
      : '<span class="hint">unknown</span>';
    const board = d.board
      ? "<code>" + escapeHtml(d.board) + "</code>"
      : '<span class="hint">unknown</span>';
    const uptime = d.created_at
      ? '<span title="First seen ' + escapeHtml(new Date(d.created_at * 1000).toLocaleString()) + '">' + formatUptime(d.created_at) + "</span>"
      : '<span class="hint">n/a</span>';
    const currentImageThumbUrl = d.current_image && d.current_image.id ? thumbnailUrlCache[d.current_image.id] : null;
    const currentImage = !d.current_image
      ? '<span class="hint">n/a</span>'
      : currentImageThumbUrl
      ? '<div class="thumb-wrap" onmouseenter="onThumbHover(this, \'full-device-' + escapeHtml(d.mac) + '\', \'' + d.current_image.id + '\', \'' + escapeHtml(d.current_image.source_bucket_id) + '\')">' +
          '<img class="thumb" src="' + currentImageThumbUrl + '" alt="" width="34" height="45">' +
          '<div class="thumb-popup" id="full-device-' + escapeHtml(d.mac) + '"><p class="hint">Loading…</p></div>' +
        "</div>"
      : escapeHtml(d.current_image.filename);
    return "<tr>" +
      "<td><code>" + escapeHtml(d.mac) + "</code></td>" +
      "<td>" + escapeHtml(d.label || "") + "</td>" +
      "<td>" + board + "</td>" +
      "<td>" + currentImage + "</td>" +
      "<td>" + firmware + "</td>" +
      "<td>" + uptime + "</td>" +
      "<td>" + lastSeen + "</td>" +
      "<td>" + battery + "</td>" +
      "<td>" + bucketLabelsFor(d.bucket_ids) + '<br><button class="ghost" onclick="openBucketModal(\'' + escapeHtml(d.mac) + '\')">Manage</button></td>' +
      '<td><button class="ghost" onclick="openScheduleModal(\'' + escapeHtml(d.mac) + '\')">Manage</button></td>' +
      '<td><button class="danger" onclick="deleteDevice(\'' + escapeHtml(d.mac) + '\')">Remove</button></td>' +
      "</tr>";
  }).join("");
}

function scheduleFormHtml(target: string, override: any): string {
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
      '<button onclick="saveSchedule(\'' + target + '\')">Save</button>' +
      (has ? '<button class="ghost" onclick="clearSchedule(\'' + target + '\')">Clear override</button>' : "") +
      '<span class="hint">' + (has ? "Override active" : "No override — falls back to the next tier") + "</span>" +
    "</div>"
  );
}

async function saveSchedule(target: string) {
  const body = {
    refresh_interval_minutes: Number(el<HTMLInputElement>("sched-refresh-" + target).value),
    active_start_hour: Number(el<HTMLInputElement>("sched-start-" + target).value),
    active_end_hour: Number(el<HTMLInputElement>("sched-end-" + target).value),
    timezone_offset_minutes: Number(el<HTMLInputElement>("sched-tz-" + target).value),
  };
  try {
    await apiFetch("/admin/schedule/" + encodeURIComponent(target), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    el("schedule-modal-overlay").classList.remove("open");
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to save schedule for " + target + ": " + err.message, "error");
  }
}
(window as any).saveSchedule = saveSchedule;

async function clearSchedule(target: string) {
  try {
    await apiFetch("/admin/schedule/" + encodeURIComponent(target), { method: "DELETE" });
    el("schedule-modal-overlay").classList.remove("open");
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to clear schedule for " + target + ": " + err.message, "error");
  }
}
(window as any).clearSchedule = clearSchedule;

// Sniffs raw-image magic bytes to give the decrypted Blob a real MIME type —
// the server can no longer do this (ciphertext, not an image) the way
// lib/decode.ts's old sniffImageContentType did before encryption landed.
function sniffImageContentType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "application/octet-stream";
}

// Decrypts ciphertext (thumbnail or raw original) with the given bucket's
// content key into a renderable object URL. Throws if that bucket's key isn't
// unlocked in this session or the ciphertext is corrupt/stale.
async function decryptBytesToObjectUrl(bucketId: string, ciphertext: Uint8Array): Promise<string> {
  const key = bucketAesKeys.get(bucketId);
  if (!key) throw new Error("bucket key not unlocked in this session");
  const plaintext = await aesGcmDecryptBlob(key, ciphertext);
  return URL.createObjectURL(new Blob([new Uint8Array(plaintext)], { type: sniffImageContentType(plaintext) }));
}

// Same, from a base64 ciphertext (thumbnails arrive this way in JSON). Null
// on any failure — callers show a placeholder rather than propagate the
// error into a crashed render.
async function decryptToObjectUrl(bucketId: string, ciphertextB64: string): Promise<string | null> {
  try {
    return await decryptBytesToObjectUrl(bucketId, fromBase64(ciphertextB64));
  } catch {
    return null;
  }
}

// imageId -> decrypted object URL for thumbnails, populated fresh by
// renderApp() on every render (old URLs are revoked first — see renderApp).
const thumbnailUrlCache: Record<string, string> = {};

const fullImageUrlCache: Record<string, string> = {};

// The popup is position:fixed, so top/left are viewport-relative and must be
// computed on every hover (scroll position and which grid column the thumbnail
// sits in both affect where it'd otherwise run off-screen). Sized against the
// worst case (the img's own max-width/max-height are 45vw/70vh) rather than the
// popup's actual rendered size, which isn't known until the image finishes
// loading — this only ever leaves extra margin, never causes an overflow.
function positionThumbPopup(wrapEl: HTMLElement, popupEl: HTMLElement) {
  const margin = 10;
  const maxW = window.innerWidth * 0.45 + 14;
  const maxH = window.innerHeight * 0.70 + 14;
  const rect = wrapEl.getBoundingClientRect();

  let left = rect.right + 8;
  if (left + maxW > window.innerWidth - margin) {
    left = rect.left - maxW - 8;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - maxW - margin));

  let top = Math.min(rect.top, window.innerHeight - maxH - margin);
  top = Math.max(margin, top);

  popupEl.style.left = left + "px";
  popupEl.style.top = top + "px";
}

// popupId is the DOM id of this thumb's popup div; imageId is what's fetched/cached.
// Kept separate because the same image can appear in two different popups at once
// (e.g. a device's "Current image" and its source bucket's row both show it) —
// reusing "full-" + imageId as the DOM id for both would collide. bucketId says
// which content key decrypts this image's ciphertext once fetched.
function onThumbHover(wrapEl: HTMLElement, popupId: string, imageId: string, bucketId: string) {
  const popup = document.getElementById(popupId);
  if (popup) positionThumbPopup(wrapEl, popup);
  loadFullImage(popupId, imageId, bucketId);
}
(window as any).onThumbHover = onThumbHover;

// Lazy-loaded on first hover (the raw endpoint re-checks ownership per request,
// so there's no point prefetching every thumbnail's full image up front). Cached
// by object URL per image id so repeat hovers in the same session are instant.
async function loadFullImage(popupId: string, imageId: string, bucketId: string) {
  const popup = document.getElementById(popupId) as HTMLElement | null;
  if (!popup || popup.dataset.loaded) return;
  if (fullImageUrlCache[imageId]) {
    popup.innerHTML = '<img src="' + fullImageUrlCache[imageId] + '" alt="">';
    popup.dataset.loaded = "1";
    return;
  }
  try {
    const res = await fetch("/admin/images/" + encodeURIComponent(imageId) + "/raw", {
      headers: { Authorization: "Bearer " + getApiKey() },
    });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    const ciphertext = new Uint8Array(await res.arrayBuffer());
    const url = await decryptBytesToObjectUrl(bucketId, ciphertext);
    fullImageUrlCache[imageId] = url;
    popup.innerHTML = '<img src="' + url + '" alt="">';
    popup.dataset.loaded = "1";
  } catch (err: any) {
    popup.innerHTML = '<p class="hint">Failed to load: ' + escapeHtml(err.message) + "</p>";
  }
}
(window as any).loadFullImage = loadFullImage;

async function deleteImage(id: string) {
  if (!confirm("Delete this image? This cannot be undone.")) return;
  try {
    await apiFetch("/admin/images/" + encodeURIComponent(id), { method: "DELETE" });
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to delete image: " + err.message, "error");
  }
}
(window as any).deleteImage = deleteImage;

/**
 * Decode -> EXIF-correct -> resize/crop -> rotate -> enhance -> dither -> pack
 * -> hash -> encrypt now all run here, client-side — the Worker never sees
 * plaintext (see root CLAUDE.md's encrypted-buckets plan). `packed_hash` is
 * computed over the encrypted packed blob, not the plaintext, since that's
 * the only thing the server can compare on later requests.
 */
async function uploadImage(deviceKey: string) {
  const fileInput = el<HTMLInputElement>("upload-file-" + deviceKey);
  const filenameInput = el<HTMLInputElement>("upload-filename-" + deviceKey);
  const ditherSelect = el<HTMLSelectElement>("upload-dither-" + deviceKey);
  const file = fileInput.files ? fileInput.files[0] : undefined;
  if (!file) { showMessage("app-message", "Choose a file first.", "error"); return; }
  const filename = (filenameInput.value || file.name).trim();
  const dither = ditherSelect.value as DitherAlgorithm;

  const bucketKey = bucketAesKeys.get(deviceKey);
  if (!bucketKey) {
    showMessage("app-message", "This bucket's key isn't unlocked in this session — log out and back in with your passkey.", "error");
    return;
  }

  try {
    showMessage("app-message", "Processing and encrypting image…", "");
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const landscape = await decodeToLandscapeBuffer(file);
    enhance(landscape.rgba, landscape.width, landscape.height, DEFAULT_BRIGHTNESS, DEFAULT_CONTRAST, DEFAULT_SATURATION);
    const indices = ditherImage(landscape.rgba, landscape.width, landscape.height, dither);
    const packed = packToNibbles(indices);
    const thumbnail = await makeThumbnailJpeg(landscape.portrait.rgba, landscape.portrait.width, landscape.portrait.height);

    const [rawCiphertext, packedCiphertext, thumbCiphertext] = await Promise.all([
      aesGcmEncryptBlob(bucketKey, rawBytes),
      aesGcmEncryptBlob(bucketKey, packed),
      aesGcmEncryptBlob(bucketKey, thumbnail),
    ]);
    const packedHash = await computeHash16(packedCiphertext);

    const formData = new FormData();
    formData.set("dither_algorithm", dither);
    formData.set("packed_hash", packedHash);
    formData.set("raw", new Blob([new Uint8Array(rawCiphertext)]), "raw.bin");
    formData.set("packed", new Blob([new Uint8Array(packedCiphertext)]), "packed.bin");
    formData.set("thumb", new Blob([new Uint8Array(thumbCiphertext)]), "thumb.bin");

    // No Content-Type header: FormData needs the browser to set its own
    // multipart boundary, which apiFetch only does when we don't override it.
    await apiFetch(
      "/admin/images/upload?device_key=" + encodeURIComponent(deviceKey) + "&filename=" + encodeURIComponent(filename),
      { method: "POST", body: formData }
    );
    fileInput.value = "";
    filenameInput.value = "";
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to upload image: " + err.message, "error");
  }
}
(window as any).uploadImage = uploadImage;

function bucketCardHtml(bucket: any, images: any[], collaborators: any[]): string {
  const deviceKey = bucket.id;
  const rows = images.length
    ? images.map((img) =>
        "<tr>" +
        "<td>" + (thumbnailUrlCache[img.id]
          ? '<div class="thumb-wrap" onmouseenter="onThumbHover(this, \'full-' + img.id + '\', \'' + img.id + '\', \'' + escapeHtml(bucket.id) + '\')">' +
              '<img class="thumb" src="' + thumbnailUrlCache[img.id] + '" alt="" width="45" height="60">' +
              '<div class="thumb-popup" id="full-' + img.id + '"><p class="hint">Loading…</p></div>' +
            "</div>"
          : '<span class="hint">n/a</span>') + "</td>" +
        "<td><code>" + escapeHtml(img.filename) + "</code></td>" +
        '<td><span class="pill">' + escapeHtml(img.dither_algorithm) + "</span></td>" +
        "<td>" + new Date(img.created_at * 1000).toLocaleDateString() + "</td>" +
        '<td><button class="danger" onclick="deleteImage(\'' + img.id + '\')">Delete</button></td>' +
        "</tr>"
      ).join("")
    : '<tr><td colspan="5" class="hint">No images yet.</td></tr>';

  const ditherOptions = DITHER_ALGORITHMS.map((a) => '<option value="' + a + '">' + a + "</option>").join("");

  const isOwnedShareable = bucket.is_owner;
  const collabList = collaborators.length
    ? '<ul class="collab-list">' +
      collaborators
        .map(
          (u) =>
            "<li>" + escapeHtml(u.display_name || "Account " + u.id.slice(0, 8)) +
            ' <button class="ghost" onclick="removeBucketCollaborator(\'' + escapeHtml(bucket.id) + '\', \'' + escapeHtml(u.id) + '\')">Remove</button></li>'
        )
        .join("") +
      "</ul>"
    : '<p class="hint">No collaborators yet.</p>';

  const ownerSection = isOwnedShareable
    ? '<h4 style="margin-top:18px;">Sharing</h4>' +
      collabList +
      '<div class="inline-form" style="margin-top:8px;">' +
        '<button class="ghost" onclick="createBucketInvite(\'' + escapeHtml(bucket.id) + '\')">Get invite link</button>' +
        '<button class="danger" onclick="deleteBucket(\'' + escapeHtml(bucket.id) + '\')">Delete bucket</button>' +
      "</div>"
    : "";

  const titleRow =
    "<h3>" + escapeHtml(bucket.label) + ' <span class="pill">' + images.length + (images.length === 1 ? " image" : " images") + "</span>" +
    (isOwnedShareable ? ' <button class="ghost" onclick="renameBucket(\'' + escapeHtml(bucket.id) + '\')">Rename</button>' : "") +
    "</h3>";

  return (
    '<div class="card">' +
      titleRow +
      "<table><thead><tr><th></th><th>Filename</th><th>Dither</th><th>Uploaded</th><th></th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>" +
      '<div class="inline-form" style="margin-top:12px;">' +
        '<div class="row"><label>Image file</label><input type="file" id="upload-file-' + deviceKey + '" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"></div>' +
        '<div class="row"><label>Filename</label><input type="text" id="upload-filename-' + deviceKey + '" placeholder="(from file)"></div>' +
        '<div class="row"><label>Dither</label><select id="upload-dither-' + deviceKey + '">' + ditherOptions + "</select></div>" +
        '<button onclick="uploadImage(\'' + deviceKey + '\')">Upload</button>' +
      "</div>" +
      ownerSection +
    "</div>"
  );
}

async function createBucketInvite(bucketId: string) {
  const bucketKey = bucketAesKeys.get(bucketId);
  if (!bucketKey) {
    showMessage("app-message", "This bucket's key isn't unlocked in this session.", "error");
    return;
  }
  try {
    const result = await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId) + "/invite", { method: "POST" });
    // The raw bucket key travels only as a URL fragment — never sent to the
    // server (not in this request, not in Referer headers, not in server
    // logs). The invitee's browser reads it client-side; see joinBucket().
    const rawKey = await exportAesKeyRaw(bucketKey);
    const url = result.url + "#key=" + toBase64Url(rawKey);
    try {
      await navigator.clipboard.writeText(url);
      alert("Invite link copied to clipboard (keep it private — anyone with this link can read the bucket):\n\n" + url);
    } catch {
      alert("Invite link (copy manually — keep it private):\n\n" + url);
    }
  } catch (err: any) {
    showMessage("app-message", "Failed to create invite link: " + err.message, "error");
  }
}
(window as any).createBucketInvite = createBucketInvite;

async function renameBucket(bucketId: string) {
  const bucket = allBucketsCache.find((b) => b.id === bucketId);
  const next = prompt("New label:", (bucket && bucket.label) || "");
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  try {
    await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: trimmed }),
    });
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to rename bucket: " + err.message, "error");
  }
}
(window as any).renameBucket = renameBucket;

async function deleteBucket(bucketId: string) {
  if (!confirm("Delete this bucket and all its images? This cannot be undone.")) return;
  try {
    await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId), { method: "DELETE" });
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to delete bucket: " + err.message, "error");
  }
}
(window as any).deleteBucket = deleteBucket;

async function removeBucketCollaborator(bucketId: string, userId: string) {
  if (!confirm("Remove this collaborator's access to the bucket?")) return;
  try {
    await apiFetch(
      "/admin/buckets/" + encodeURIComponent(bucketId) + "/collaborators/" + encodeURIComponent(userId),
      { method: "DELETE" }
    );
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to remove collaborator: " + err.message, "error");
  }
}
(window as any).removeBucketCollaborator = removeBucketCollaborator;

el("create-bucket-btn").addEventListener("click", async () => {
  const input = el<HTMLInputElement>("new-bucket-label");
  const label = input.value.trim();
  if (!label) return;
  if (!sharingPublicKeyRaw) {
    showMessage("app-message", "Can't create an encrypted bucket yet — log out and back in with your passkey first.", "error");
    return;
  }
  try {
    // The bucket's AES-256-GCM content key is generated here, client-side, and
    // never sent to the Worker raw — only this wrap of it for our own key.
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);
    const key = await wrapKeyFor(sharingPublicKeyRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    await apiFetch("/admin/buckets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, key }),
    });
    input.value = "";
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to create bucket: " + err.message, "error");
  }
});

el("firmware-sync-btn").addEventListener("click", async () => {
  try {
    // Keyed by board — see routes/admin/firmware.ts's syncLatestFirmwareRelease.
    const result: Record<string, { version: string; isNew: boolean } | null> = await apiFetch("/admin/firmware/sync", { method: "POST" });
    const summary = Object.entries(result)
      .map(([board, r]) => board + ": " + (r ? (r.isNew ? "synced " + r.version : "up to date (" + r.version + ")") : "no release found"))
      .join(", ");
    showMessage("app-message", summary, "success");
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to sync firmware: " + err.message, "error");
  }
});

async function clearFirmwareTarget(target: string) {
  try {
    await apiFetch("/admin/firmware/target/" + encodeURIComponent(target), { method: "DELETE" });
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to clear firmware target for " + target + ": " + err.message, "error");
  }
}
(window as any).clearFirmwareTarget = clearFirmwareTarget;

el("firmware-target-save-btn").addEventListener("click", async () => {
  const target = el<HTMLSelectElement>("firmware-target-select").value;
  const channel = el<HTMLSelectElement>("firmware-channel-select").value;
  if (!target || !channel) return;
  try {
    await apiFetch("/admin/firmware/target/" + encodeURIComponent(target), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to set firmware channel: " + err.message, "error");
  }
});

function renderFirmwareReleasesTable(releases: any[]) {
  const tbody = el("firmware-releases-table");
  tbody.innerHTML = releases.length
    ? releases.map((r) =>
        "<tr>" +
        "<td><code>" + escapeHtml(r.board) + "</code></td>" +
        "<td><code>" + escapeHtml(r.version) + "</code></td>" +
        "<td>" + escapeHtml(r.tag) + "</td>" +
        "<td>" + Math.round(r.size_bytes / 1024) + " KB</td>" +
        "<td><code>" + escapeHtml(r.sha256.slice(0, 12)) + "&hellip;</code></td>" +
        "<td>" + new Date(r.created_at * 1000).toLocaleString() + "</td>" +
        "</tr>"
      ).join("")
    : '<tr><td colspan="6" class="hint">No releases synced yet.</td></tr>';
}

function renderFirmwareTargetsTable(targets: any[]) {
  const tbody = el("firmware-targets-table");
  tbody.innerHTML = targets.length
    ? targets.map((t) =>
        "<tr>" +
        "<td><code>" + escapeHtml(t.target) + "</code></td>" +
        "<td><code>" + escapeHtml(t.channel) + "</code></td>" +
        "<td>" + new Date(t.updated_at * 1000).toLocaleString() + "</td>" +
        '<td><button class="ghost" onclick="clearFirmwareTarget(\'' + escapeHtml(t.target) + '\')">Clear</button></td>' +
        "</tr>"
      ).join("")
    : '<tr><td colspan="4" class="hint">No channels set — no device will OTA.</td></tr>';
}

function renderFirmwareTargetForm(devices: any[]) {
  const targetSelect = el<HTMLSelectElement>("firmware-target-select");
  targetSelect.innerHTML = devices
    .map((d) => '<option value="' + escapeHtml(d.mac) + '">' + escapeHtml((d.label || d.mac) + " (" + d.mac + ")") + "</option>")
    .join("");
}

function renderCrashReportsTable(reports: any[]) {
  const tbody = el("crash-reports-table");
  tbody.innerHTML = reports.length
    ? reports.map((r) => {
        const backtrace = r.backtrace ? (JSON.parse(r.backtrace) as string[]).join(" ") : r.crash_pc || "";
        return (
          "<tr>" +
          "<td><code>" + escapeHtml(r.device_mac) + "</code></td>" +
          "<td><code>" + escapeHtml(r.firmware_version) + "</code></td>" +
          "<td>" + escapeHtml(r.reset_reason) + (r.crash_task ? " (" + escapeHtml(r.crash_task) + ")" : "") + "</td>" +
          "<td>" + (r.rolled_back ? "yes (" + r.boot_attempts + " attempts)" : "no") + "</td>" +
          "<td><code style=\"font-size:11px; word-break:break-all;\">" + escapeHtml(backtrace) + "</code></td>" +
          "<td>" + new Date(r.received_at * 1000).toLocaleString() + "</td>" +
          "</tr>"
        );
      }).join("")
    : '<tr><td colspan="6" class="hint">No crash or rollback reports.</td></tr>';
}

function renderClaimBanner() {
  const params = new URLSearchParams(location.search);
  const claimMac = params.get("claim");
  const banner = el("claim-banner");
  if (!claimMac) {
    banner.innerHTML = "";
    pendingClaimSecret = null;
    return;
  }
  // The device's own HMAC secret, carried here only because it was scanned off
  // that device's physical display (see lib/registration-url.ts) — stashed so
  // the Register click below can bind it, never re-displayed or re-editable.
  pendingClaimSecret = params.get("secret");
  banner.innerHTML =
    '<div class="message success">' +
    "Scanned from a new device: <code>" + escapeHtml(claimMac) + "</code>. " +
    "Enter a label below and click Register to add it to your account." +
    "</div>";
  el<HTMLInputElement>("new-device-mac").value = claimMac;
  el("new-device-label").focus();
}

function renderJoinBucketBanner() {
  const params = new URLSearchParams(location.search);
  const token = params.get("join_bucket");
  const banner = el("join-bucket-banner");
  if (!token) {
    banner.innerHTML = "";
    return;
  }
  banner.innerHTML =
    '<div class="message success">' +
    "You've been invited to a shared image bucket. " +
    '<button onclick="joinBucket(\'' + escapeHtml(token) + '\')">Join</button>' +
    "</div>";
}

// The raw bucket key travels as a URL fragment (`#key=...`), appended by the
// inviter's browser (see createBucketInvite) and never sent to the server —
// read directly off location.hash here, client-side only.
function readBucketKeyFragment(): Uint8Array | null {
  const match = /(?:^|[#&])key=([^&]+)/.exec(location.hash);
  if (!match) return null;
  try {
    return fromBase64Url(match[1]!);
  } catch {
    return null;
  }
}

async function joinBucket(token: string) {
  if (!sharingPublicKeyRaw) {
    showMessage("app-message", "Log in with your passkey first, then use the invite link again.", "error");
    return;
  }
  try {
    const body: { token: string; key?: WrappedKey } = { token };
    const rawKey = readBucketKeyFragment();
    if (rawKey) {
      // Immediately re-wrap a durable copy for our own key — ordinary future
      // access never needs this link/fragment again.
      body.key = await wrapKeyFor(sharingPublicKeyRaw, rawKey, HKDF_INFO_BUCKET_WRAP);
    }
    const result = await apiFetch("/admin/buckets/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    history.replaceState(null, "", location.pathname); // drops ?join_bucket= and #key= alike
    el("join-bucket-banner").innerHTML = "";
    showMessage("app-message", 'Joined bucket "' + result.label + '".', "success");
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to join bucket: " + err.message, "error");
  }
}
(window as any).joinBucket = joinBucket;

async function renderApp() {
  showMessage("app-message", "", "");
  renderClaimBanner();
  renderJoinBucketBanner();
  const [devicesResult, bucketsResult] = await Promise.all([
    apiFetch("/admin/devices"),
    apiFetch("/admin/buckets"),
  ]);
  const devices = devicesResult.devices;
  devicesCache = devices;
  allBucketsCache = bucketsResult.buckets;

  // Unwrap every bucket's content key this session can access, before
  // rendering anything that needs to decrypt a thumbnail. A bucket this
  // account can see but has no usable key for (sharingPrivateKey not
  // unlocked, or a stale/corrupt wrap) just renders without thumbnails —
  // see decryptToObjectUrl's callers below.
  bucketAesKeys.clear();
  if (sharingPrivateKey) {
    await Promise.all(allBucketsCache.map(async (b) => {
      if (!b.key) return;
      try {
        const raw = await unwrapKeyWith(sharingPrivateKey!, b.key as WrappedKey, HKDF_INFO_BUCKET_WRAP);
        bucketAesKeys.set(b.id, await importAesKeyRaw(raw));
      } catch {
        // Leave this one bucket undecryptable rather than fail the whole render.
      }
    }));
  } else {
    showMessage("app-message", "Log in with your passkey (not just an API key) to unlock encrypted bucket contents.", "error");
  }

  // Old object URLs point at Blobs from the previous render — revoke before
  // repopulating so repeated renderApp() calls (every action re-renders)
  // don't leak them for the life of the tab.
  for (const url of Object.values(thumbnailUrlCache)) URL.revokeObjectURL(url);
  for (const key of Object.keys(thumbnailUrlCache)) delete thumbnailUrlCache[key];

  await Promise.all(
    devices
      .filter((d: any) => d.current_image && d.current_image.id && d.current_image.thumbnail_ciphertext_b64)
      .map(async (d: any) => {
        const url = await decryptToObjectUrl(d.current_image.source_bucket_id, d.current_image.thumbnail_ciphertext_b64);
        if (url) thumbnailUrlCache[d.current_image.id] = url;
      })
  );
  renderDevicesTable(devices);

  const bucketsEl = el("buckets");
  bucketsEl.innerHTML = allBucketsCache.map((b) => '<div id="bucket-' + b.id + '"></div>').join("");

  await Promise.all(allBucketsCache.map(async (b) => {
    const isOwnedShareable = b.is_owner;
    const [imagesResult, collaboratorsResult] = await Promise.all([
      apiFetch("/admin/images?device_key=" + encodeURIComponent(b.id)),
      isOwnedShareable
        ? apiFetch("/admin/buckets/" + encodeURIComponent(b.id) + "/collaborators")
        : Promise.resolve({ collaborators: [] }),
    ]);
    await Promise.all(
      imagesResult.images
        .filter((img: any) => img.thumbnail_ciphertext_b64)
        .map(async (img: any) => {
          const url = await decryptToObjectUrl(b.id, img.thumbnail_ciphertext_b64);
          if (url) thumbnailUrlCache[img.id] = url;
        })
    );
    el("bucket-" + b.id).innerHTML = bucketCardHtml(
      b,
      imagesResult.images,
      collaboratorsResult.collaborators
    );
  }));

  const [releasesResult, targetsResult, crashReportsResult] = await Promise.all([
    apiFetch("/admin/firmware/releases"),
    apiFetch("/admin/firmware/targets"),
    apiFetch("/admin/crash-reports"),
  ]);
  renderFirmwareReleasesTable(releasesResult.releases);
  renderFirmwareTargetsTable(targetsResult.targets);
  renderFirmwareTargetForm(devices);
  renderCrashReportsTable(crashReportsResult.reports);
}

tryLogin(false);
