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
  computeContentHash,
  importPrivateKeyPkcs8,
  toBase64,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyFor,
  type WrappedKey,
} from "./crypto";
import { DEFAULT_CROP, decodeToBoardBuffer, resizeForStorage, type CropParams } from "./decode";
import { computeHash16, ditherImage, enhance, packToNibbles } from "../lib/dither";
import { BOARD_IDS, DEFAULT_BOARD_ID, type DitherAlgorithm } from "../lib/media-constants";
import { compressPackedForUpload } from "./compress";
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

// CSS size of the crop viewport (see .crop-viewport in style.css) — EE02's
// upright (pre-rotation) 3:4 ratio (1200x1600). A bucket isn't board-scoped
// (migrations/0019_image_board_variants.sql) and confirmUpload()/
// reencryptOneImage() always crop+pack for every board from this one
// interactive crop, so there's one reference box for the preview rather than
// a per-board one: the same panX/panY/zoom fractions this box produces are
// applied independently against each other board's own upright target in
// decode.ts's decodeToBoardBuffer — a reasonable approximation for boards
// with a different aspect ratio (EE04's upright crop is 3:5, not 3:4), not a
// second crop UI.
const CROP_BOX_W = 210;
const CROP_BOX_H = 280;
let uploadModalDeviceKey: string | null = null;
let uploadModalFile: File | null = null;
let uploadObjectUrl: string | null = null;
let cropNatural = { w: 0, h: 0 };
let cropState: CropParams = { ...DEFAULT_CROP };
let cropDrag: { startX: number; startY: number; startLeft: number; startTop: number } | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c] ?? c);
}

/** A complete JS string literal (JSON.stringify's quotes included) safe to embed
 *  inside a double-quoted HTML attribute that holds JavaScript — e.g.
 *  `'<button onclick="fn(' + jsArg(x) + ')">'`. escapeHtml() alone is NOT safe
 *  in that position: the HTML parser decodes entities in attribute values
 *  BEFORE the JS engine parses the handler code, so escapeHtml's `&#39;`
 *  becomes a literal `'` again and terminates the handler's single-quoted
 *  string — the old `escapeHtml(x).replace(/'/g, "\\'")` idiom was a no-op
 *  against exactly that, leaving a stored-XSS hole in every onclick that
 *  interpolated a filename/label/mac. JSON.stringify escapes quotes,
 *  backslashes, and all control characters in one pass, so the only thing
 *  left to HTML-escape is the delimiting double quotes themselves (plus &/</>
 *  for the attribute context), which decode back into exactly the JS the
 *  stringify produced. */
function jsArg(value: unknown): string {
  return escapeHtml(JSON.stringify(String(value)));
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
    let body: any = null;
    try {
      body = await res.json();
      if (body && body.error) message = body.error;
    } catch {}
    // 429 responses are plain text (rateLimitedResponse) with a Retry-After
    // header — show that instead of a bare status code, so "rate limited,
    // retry in Ns" isn't indistinguishable from an auth failure.
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      message = "rate limited" + (retryAfter ? ` — retry in ${retryAfter}s` : "");
      body = null;
    }
    // Structured extras for callers that branch on a specific failure (e.g.
    // confirmUpload's 409 duplicate flow) — every existing catch site only
    // reads err.message, so this is purely additive.
    const err = new Error(message) as Error & { status?: number; body?: any };
    err.status = res.status;
    err.body = body;
    throw err;
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
  if (!res.ok) {
    let message = data.error || (res.status + " " + res.statusText);
    // Same as apiFetch: surface Retry-After on rate limits (plain-text body,
    // no JSON error field) so a burned passkey-ceremony budget reads as what
    // it is, not as a vague failure.
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      message = "rate limited" + (retryAfter ? ` — retry in ${retryAfter}s` : "");
    }
    throw new Error(message);
  }
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

function toggleAccordion(id: string) {
  el(id).classList.toggle("open");
}
(window as any).toggleAccordion = toggleAccordion;

function passkeysSupported(): boolean {
  const PKC = (window as any).PublicKeyCredential;
  return !!(PKC && PKC.parseCreationOptionsFromJSON && PKC.parseRequestOptionsFromJSON);
}

// Must match lib/webauthn.ts's PRF_SALT exactly (same literal string, so the
// same raw bytes) — the salt isn't secret, it only needs to be fixed so the
// same credential always yields the same PRF output.
const PRF_SALT_BYTES = new TextEncoder().encode("eink-pictureframe-prf-salt-v1");

/**
 * PublicKeyCredential.parseCreationOptionsFromJSON()/parseRequestOptionsFromJSON()
 * are relied on to convert the server's base64url `extensions.prf.eval.first`
 * into a real ArrayBuffer before navigator.credentials.create()/get() sees it
 * — but PRF's specific JSON-serialization conversion is a newer, less
 * uniformly-implemented corner of that spec than the extension itself. If a
 * browser's parser doesn't know about `prf`'s nested fields, it silently
 * leaves `first` as a plain string, the browser's WebAuthn engine can't
 * evaluate PRF with a malformed input, and PRF quietly never fires — for
 * every account, on every ceremony, regardless of how PRF-capable the actual
 * authenticator is (this was happening in practice, not hypothetically: see
 * git history around 2026-09-17). Since the salt is a fixed constant known to
 * both sides already, sidestep the conversion entirely for this one field
 * rather than trust it — construct the real ArrayBuffer ourselves.
 */
function ensurePrfExtensionInput(options: any): void {
  options.extensions = options.extensions || {};
  options.extensions.prf = { eval: { first: PRF_SALT_BYTES } };
}

/** Reads this ceremony's WebAuthn PRF result, if the authenticator returned
 *  one — undefined otherwise (older security keys, unsupported platforms). */
function readPrfOutput(credential: any): ArrayBuffer | undefined {
  const results = credential.getClientExtensionResults?.();
  const output = results?.prf?.results?.first;
  console.log("WebAuthn PRF extension results:", results?.prf, output ? `got ${output.byteLength}-byte output` : "no output");
  return output;
}

/** Called once, right after a successful registration ceremony: generates
 *  this account's sharing keypair and always caches it in this browser's
 *  IndexedDB (see keystore.ts) so a later plain page reload — resumed via
 *  the cached API key alone, with no fresh WebAuthn ceremony — can restore it
 *  (see tryLogin()) instead of leaving the user locked out of their own
 *  buckets until they re-run a full passkey prompt. If this ceremony's
 *  authenticator also supports PRF, the key is additionally wrapped for
 *  upload alongside the registration verify call, so OTHER browsers can
 *  recover it too; otherwise sharing_public_key stays null server-side until
 *  a later login backfills it (see completeLoginSharingKey below), so this
 *  account can't yet be shared *into* buckets by others from this state.
 *  Populates the module-level sharingPrivateKey/sharingPublicKeyRaw either way. */
async function completeRegistrationSharingKey(
  credential: any
): Promise<Partial<{ sharing_public_key: string; wrapped_sharing_key: string; wrap_nonce: string }>> {
  const keyPair = await generateP256KeyPair();
  sharingPrivateKey = keyPair.privateKey;
  sharingPublicKeyRaw = await exportPublicKeyRaw(keyPair.publicKey);
  const privateKeyPkcs8 = await exportPrivateKeyPkcs8(keyPair.privateKey);
  await localKeystoreSet({ publicKeyRaw: sharingPublicKeyRaw, privateKeyPkcs8 });

  const prfOutput = readPrfOutput(credential);
  if (!prfOutput) return {};
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
 *  already exists is harmless, just redundant).
 *
 *  Every recovery path here also caches the raw key in this browser's
 *  IndexedDB (see keystore.ts), even the PRF-success one below — previously
 *  that path left it purely in memory, which meant a plain page reload
 *  (tryLogin resuming from the cached API key, no fresh WebAuthn ceremony)
 *  had nothing to restore and re-locked every bucket until the user ran a
 *  full passkey prompt again, EVERY reload. Caching it here means that only
 *  has to happen once per browser (or after this browser's site data is
 *  cleared), matching ordinary "stay logged in" expectations. */
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
    await localKeystoreSet({ publicKeyRaw: sharingPublicKeyRaw, privateKeyPkcs8 });
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

  // The account already has an established sharing identity (the server has
  // a sharing_public_key for it), but this ceremony can't recover the
  // matching private key: no PRF output this time (common for cross-device
  // "hybrid"/QR-code WebAuthn, or a browser/authenticator combo that just
  // doesn't support PRF), and nothing cached in this browser's IndexedDB.
  // Minting a fresh keypair here — as this used to do — would silently FORK
  // the account's cryptographic identity per browser: the new key can't
  // decrypt anything wrapped for the real one, and (with no PRF output) it
  // never even reaches the server to be discovered as wrong, so every other
  // browser keeps using the real key while this one quietly diverges. Fail
  // loudly instead — the caller surfaces this the same way as any other
  // login failure.
  if (loginResult.sharing_public_key) {
    throw new Error(
      "This browser or authenticator can't unlock your account's encrypted buckets right now (no usable passkey PRF result). " +
      "Try again from the browser/device where you first set this up, or a browser with full passkey PRF support."
    );
  }

  // No server key and no local key either — a genuinely brand new identity
  // (e.g. this account's very first login, after a registration whose own
  // ceremony also had no PRF, so nothing was ever wrapped anywhere yet):
  // generate fresh, same as a first registration.
  const keyPair = await generateP256KeyPair();
  sharingPrivateKey = keyPair.privateKey;
  sharingPublicKeyRaw = await exportPublicKeyRaw(keyPair.publicKey);
  const privateKeyPkcs8 = await exportPrivateKeyPkcs8(keyPair.privateKey);
  await localKeystoreSet({ publicKeyRaw: sharingPublicKeyRaw, privateKeyPkcs8 });
  if (prfOutput) {
    const kek = await deriveKekFromPrf(prfOutput);
    const { nonce, ciphertext } = await aesGcmEncryptToStrings(kek, privateKeyPkcs8);
    return { sharing_public_key: toBase64(sharingPublicKeyRaw), wrapped_sharing_key: ciphertext, wrap_nonce: nonce };
  }
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
    ensurePrfExtensionInput(creationOptions);
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

// The actual WebAuthn login ceremony, shared by the pre-login "Log in with
// passkey" button and unlockSharingKey() below — the latter runs it again
// for an already-logged-in-via-cached-API-key session that never got a
// sharing key, since a fresh PRF result is only ever available mid-ceremony
// (there's no way to request just PRF without a full assertion). Re-running
// it for an already-authenticated account is harmless: it just re-verifies
// the same passkey and overwrites the cached API key with an equivalent one.
async function performPasskeyLoginCeremony(): Promise<void> {
  const { attemptId, options } = await publicFetch("/auth/login/options", {});
  const requestOptions = (window as any).PublicKeyCredential.parseRequestOptionsFromJSON(options);
  ensurePrfExtensionInput(requestOptions);
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
}

el("passkey-login-btn").addEventListener("click", async () => {
  if (!passkeysSupported()) {
    showMessage("login-message", "This browser doesn't support passkeys. Try an up-to-date Chrome, Safari, or Firefox, or use an API key below.", "error");
    return;
  }
  try {
    await performPasskeyLoginCeremony();
    await tryLogin(true);
  } catch (err: any) {
    showMessage("login-message", "Failed to log in: " + err.message, "error");
  }
});

// Called from the "Unlock with passkey" button shown when a page reload left
// currentUser signed in (via the cached API key — see tryLogin) but with no
// sharing key: a PRF-capable authenticator's key is deliberately never
// persisted anywhere (server or IndexedDB — see keystore.ts) and can only be
// recovered by an actual passkey ceremony, which tryLogin's plain API-key
// resume never performs on its own.
async function unlockSharingKey() {
  if (!passkeysSupported()) {
    showMessage("app-message", "This browser doesn't support passkeys, so encrypted buckets can't be unlocked here.", "error");
    return;
  }
  try {
    await performPasskeyLoginCeremony();
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to unlock: " + err.message, "error");
  }
}
(window as any).unlockSharingKey = unlockSharingKey;

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
    renderPublicBucketCheckboxVisibility();
    el("login").style.display = "none";
    el("app").style.display = "block";
    // On a fresh page load (as opposed to just completing a passkey ceremony,
    // which already populated these), the sharing keypair only lives in
    // memory for the tab that unlocked it. Restore it from this browser's
    // IndexedDB fallback (see keystore.ts) before rendering, so a reload
    // doesn't strand every private bucket behind "isn't unlocked in this
    // session" until the user logs out and back in with their passkey. If
    // this authenticator uses PRF instead, its key was never stashed here in
    // the first place, and this stays a no-op.
    if (!sharingPrivateKey) {
      const local = await localKeystoreGet();
      if (local) {
        sharingPrivateKey = await importPrivateKeyPkcs8(local.privateKeyPkcs8);
        sharingPublicKeyRaw = local.publicKeyRaw;
      }
    }
    await renderApp();
    return true;
  } catch (err: any) {
    // 429 is NOT an invalid key — the saved API key is still valid, so keep
    // it. Clearing here turned a transient rate limit into a forced logout,
    // and the next attempt would then burn another passkey ceremony on an
    // already-exhausted budget.
    if (err.status === 429) {
      if (showError) {
        showMessage("login-message", "Rate limited — wait a few minutes and retry. Your saved login is still valid.", "error");
      }
    } else {
      if (showError) showMessage("login-message", "Invalid API key: " + err.message, "error");
      clearApiKey();
    }
    return false;
  }
}

el("edit-name-btn").addEventListener("click", async () => {
  const next = prompt("Display name:", (currentUser && currentUser.display_name) || "");
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  if (trimmed.length > 40) {
    showMessage("app-message", "Display name must be at most 40 characters.", "error");
    return;
  }
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

function openRegisterModal() {
  el("register-modal-overlay").classList.add("open");
  el<HTMLInputElement>("new-device-mac").focus();
}
(window as any).openRegisterModal = openRegisterModal;

function closeRegisterModal() {
  el("register-modal-overlay").classList.remove("open");
}
// The "+" button now sends people through Device Setup (Bluetooth pairing +
// registration in one step) instead of this modal's manual MAC-entry form.
// The modal itself stays around only for the "scan to register" QR-claim
// flow (renderClaimBanner below), where the MAC is already known from the
// scan rather than hand-typed.
el("add-device-btn").addEventListener("click", () => { location.href = "/provision"; });
el("register-modal-close-btn").addEventListener("click", closeRegisterModal);

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
    closeRegisterModal();
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

// Only pop the bucket-assignment modal open automatically once per page
// load — see claimModalAutoOpened's comment above for why.
let assignBucketModalAutoOpened = false;

function renderAssignBucketBanner() {
  const params = new URLSearchParams(location.search);
  const mac = params.get("assign_bucket");
  const banner = el("assign-bucket-banner");
  if (!mac) {
    banner.innerHTML = "";
    return;
  }
  banner.innerHTML =
    '<div class="message success">' +
    "Scanned from a device with no images assigned yet: <code>" + escapeHtml(mac) + "</code>. " +
    '<button class="sm" onclick="openBucketModal(' + jsArg(mac) + ')">Assign buckets&hellip;</button>' +
    "</div>";
  if (!assignBucketModalAutoOpened) {
    assignBucketModalAutoOpened = true;
    openBucketModal(mac);
  }
}

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
    if (new URLSearchParams(location.search).get("assign_bucket")) {
      history.replaceState(null, "", location.pathname);
    }
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

// "Registered" means wall-clock time since the device's row was first created
// (its initial registration/provisioning), not continuous runtime — the board
// deep-sleeps between wake cycles, so there's no meaningful "time since last boot".
// Resetting or re-provisioning the hardware only updates the existing row
// (ON CONFLICT ... DO UPDATE preserves created_at), so this counter never restarts.
function formatRegisteredAge(createdAtSeconds: number): string {
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

// Short relative phrasing ("5 minutes ago", "2 days ago") for a table cell —
// the exact timestamp is still available on hover (see renderDevicesTable's
// lastSeen title attribute).
function formatRelativeTime(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
  const months = Math.round(days / 30);
  if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
  const years = Math.round(months / 12);
  return years + (years === 1 ? " year ago" : " years ago");
}

// Green/yellow/red pill matching the physical battery level, using the same
// spectra palette as everything else (see style.css's brand-dots comment).
// The raw voltage is still available on hover for anyone who wants it.
function batteryPillHtml(voltage: number): string {
  const pct = batteryPercent(voltage);
  const tone = pct >= 50 ? "green" : pct >= 20 ? "yellow" : "red";
  return '<span class="pill ' + tone + '" title="' + voltage.toFixed(2) + 'V">' + pct + "%</span>";
}

function renderDevicesTable(devices: any[]) {
  const tbody = el("devices-table");
  if (devices.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No devices registered yet &mdash; add one below.</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map((d) => {
    const battery = d.last_battery_voltage != null ? batteryPillHtml(d.last_battery_voltage) : '<span class="hint">n/a</span>';
    const lastSeen = d.last_seen_at
      ? '<span title="' + escapeHtml(new Date(d.last_seen_at * 1000).toLocaleString()) +
        (d.last_seen_ip ? " · " + escapeHtml(d.last_seen_ip) : "") + '">' +
        formatRelativeTime(d.last_seen_at) + "</span>"
      : '<span class="hint">never</span>';
    const firmware = d.running_firmware_version
      ? escapeHtml(d.running_firmware_version)
      : '<span class="hint">unknown</span>';
    const board = d.board
      ? '<span class="pill" title="MAC ' + escapeHtml(d.mac) + '">' + escapeHtml(d.board) + "</span>"
      : '<span class="hint" title="MAC ' + escapeHtml(d.mac) + '">unknown</span>';
    const registered = d.created_at
      ? '<span title="First seen ' + escapeHtml(new Date(d.created_at * 1000).toLocaleString()) + '">' + formatRegisteredAge(d.created_at) + "</span>"
      : '<span class="hint">n/a</span>';
    const currentImageThumbUrl = d.current_image && d.current_image.id ? thumbnailUrlCache[d.current_image.id] : null;
    const currentImage = !d.current_image
      ? '<span class="hint">n/a</span>'
      : currentImageThumbUrl
      ? '<img class="device-thumb" src="' + currentImageThumbUrl + '" alt="" onclick="openLightbox(' + jsArg(d.current_image.id) + ', ' + jsArg(d.current_image.source_bucket_id) + ', ' + jsArg(d.current_image.filename) + ')">'
      : escapeHtml(d.current_image.filename);
    return "<tr>" +
      "<td>" + escapeHtml(d.label || "") + "</td>" +
      "<td>" + board + "</td>" +
      "<td>" + currentImage + "</td>" +
      "<td>" + firmware + "</td>" +
      "<td>" + registered + "</td>" +
      "<td>" + lastSeen + "</td>" +
      "<td>" + battery + "</td>" +
      '<td><button class="ghost sm" onclick="openBucketModal(' + jsArg(d.mac) + ')">Manage</button></td>' +
      '<td><button class="ghost sm" onclick="openScheduleModal(' + jsArg(d.mac) + ')">Manage</button></td>' +
      '<td><button class="danger sm" onclick="deleteDevice(' + jsArg(d.mac) + ')">Remove</button></td>' +
      "</tr>";
  }).join("");
}

function scheduleFormHtml(target: string, override: any): string {
  const v = override || {};
  const has = !!override;
  // encodeURIComponent for the element ids (safe inside a double-quoted
  // attribute and invertible, so saveSchedule/clearSchedule below find the
  // same elements); jsArg for anything embedded in an onclick handler.
  const idKey = encodeURIComponent(target);
  return (
    '<div class="inline-form">' +
      '<div class="row"><label>Refresh (min)</label><input type="number" min="1" max="1440" id="sched-refresh-' + encodeURIComponent(target) + '" value="' + (v.refresh_interval_minutes ?? 60) + '"></div>' +
      '<div class="row"><label>Active start hr</label><input type="number" min="0" max="23" id="sched-start-' + encodeURIComponent(target) + '" value="' + (v.active_start_hour ?? 8) + '"></div>' +
      '<div class="row"><label>Active end hr</label><input type="number" min="0" max="23" id="sched-end-' + encodeURIComponent(target) + '" value="' + (v.active_end_hour ?? 20) + '"></div>' +
      '<div class="row"><label>TZ offset (min)</label><input type="number" min="-720" max="840" id="sched-tz-' + encodeURIComponent(target) + '" value="' + (v.timezone_offset_minutes ?? 0) + '"></div>' +
    "</div>" +
    '<div class="inline-form" style="margin-top:10px;">' +
      '<button onclick="saveSchedule(' + jsArg(target) + ')">Save</button>' +
      (has ? '<button class="ghost" onclick="clearSchedule(' + jsArg(target) + ')">Clear override</button>' : "") +
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

// Click-to-open lightbox — replaces the old hover-popup (hover doesn't exist
// on touch devices, and a popup that can run off-screen is a worse "look at
// this photo" experience than a centered overlay). Lazy-fetches/decrypts the
// full-resolution image on first open per imageId, then serves from
// fullImageUrlCache on repeat opens in the same session.
function openLightbox(imageId: string, bucketId: string, filename: string) {
  const overlay = el("lightbox-overlay");
  const content = el("lightbox-content");
  el("lightbox-caption").textContent = filename;
  content.innerHTML = '<p class="hint" style="color:white;">Loading…</p>';
  overlay.classList.add("open");
  loadLightboxImage(content, imageId, bucketId);
}
(window as any).openLightbox = openLightbox;

async function loadLightboxImage(content: HTMLElement, imageId: string, bucketId: string) {
  if (fullImageUrlCache[imageId]) {
    content.innerHTML = '<img src="' + fullImageUrlCache[imageId] + '" alt="">';
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
    content.innerHTML = '<img src="' + url + '" alt="">';
  } catch (err: any) {
    content.innerHTML = '<p class="hint" style="color:white;">Failed to load: ' + escapeHtml(err.message) + "</p>";
  }
}

function closeLightbox() {
  el("lightbox-overlay").classList.remove("open");
}
el("lightbox-close-btn").addEventListener("click", closeLightbox);
el("lightbox-overlay").addEventListener("click", (e) => {
  if (e.target === el("lightbox-overlay")) closeLightbox();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeLightbox();
    closeUploadModal();
    closeRegisterModal();
  }
});

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

// Whether this account holds a personal wrapped copy of the bucket's key —
// true for the owner and for any accepted collaborator (see the join()
// route), false for someone who can only see this bucket because it's public
// (migrations/0018_public_buckets.sql — GET /admin/buckets surfaces
// `public_key_raw` instead of `key` for exactly that case). This is the same
// yes/no assertBucketAccess would give server-side for a write attempt, so
// it's what gates upload/delete-image in the UI — distinct from `is_owner`,
// which gates the owner-only sections (rename, sharing, delete, rotation,
// public toggle) further down.
function bucketHasWriteAccess(bucket: any): boolean {
  return !!bucket.key;
}

function bucketCardHtml(bucket: any, images: any[], collaborators: any[], rotation: any | null): string {
  const canWrite = bucketHasWriteAccess(bucket);
  const tiles = images
    .map((img) => {
      const thumb = thumbnailUrlCache[img.id]
        ? '<img src="' + thumbnailUrlCache[img.id] + '" alt="">'
        : '<div class="photo-tile-empty hint">no preview</div>';
      const deleteBtn = canWrite
        ? '<button class="icon-btn photo-tile-delete" aria-label="Delete photo" onclick="event.stopPropagation(); deleteImage(' + jsArg(img.id) + ')">&#10005;</button>'
        : "";
      return (
        '<div class="photo-tile" onclick="openLightbox(' + jsArg(img.id) + ', ' + jsArg(bucket.id) + ', ' + jsArg(img.filename) + ')">' +
          thumb +
          '<span class="pill photo-tile-dither">' + escapeHtml(img.dither_algorithm) + "</span>" +
          deleteBtn +
          '<div class="photo-tile-caption">' + escapeHtml(img.filename) + "</div>" +
        "</div>"
      );
    })
    .join("");

  const addTile = canWrite
    ? '<button type="button" class="photo-tile photo-tile-add" onclick="openUploadModal(' + jsArg(bucket.id) + ')">' +
        '<span class="plus">+</span> Add photo' +
      "</button>"
    : "";

  const isOwnedShareable = bucket.is_owner;
  const collabList = collaborators.length
    ? '<ul class="collab-list">' +
      collaborators
        .map(
          (u) =>
            "<li>" + escapeHtml(u.display_name || "Account " + u.id.slice(0, 8)) +
            ' <button class="ghost sm" onclick="removeBucketCollaborator(' + jsArg(bucket.id) + ', ' + jsArg(u.id) + ')">Remove</button></li>'
        )
        .join("") +
      "</ul>"
    : '<p class="hint">No collaborators yet.</p>';

  const totalRotationImages = rotation ? rotation.done_image_ids.length + rotation.pending_image_ids.length : 0;
  const rotationSection = !isOwnedShareable
    ? ""
    : rotation
    ? '<div class="hint-block" style="margin-top:10px;">' +
        "<p><strong>Key rotation in progress:</strong> " + rotation.done_image_ids.length + " of " + totalRotationImages + " images re-encrypted.</p>" +
        '<button class="ghost sm" onclick="runBucketRotation(' + jsArg(bucket.id) + ')">Resume rotation</button>' +
      "</div>"
    : '<button class="ghost sm" onclick="runBucketRotation(' + jsArg(bucket.id) + ')">Rotate key&hellip;</button>';

  // Public toggle: superuser-only (checked client-side for display; the
  // Worker re-checks is_superuser server-side regardless — see
  // routes/admin/buckets.ts's PATCH handler), and only ever shown to the
  // owner — a collaborator can't make someone else's bucket public.
  const publicToggle =
    isOwnedShareable && currentUser && currentUser.is_superuser
      ? '<button class="ghost sm" onclick="toggleBucketPublic(' + jsArg(bucket.id) + ", " + (bucket.is_public ? "false" : "true") + ')">' +
          (bucket.is_public ? "Make private" : "Make public&hellip;") +
        "</button>"
      : "";

  // Shared-with-me cue: not the owner, but holds a personal wrapped key (a
  // collaborator via bucket_shares/join()). No display name is available for
  // another account's owner (GET /admin/buckets only returns `owner_id`, a
  // raw uuid — same fallback style as collabList's own "no display_name" case
  // above) rather than inventing a new API field for this.
  const isSharedWithMe = !isOwnedShareable && canWrite;

  const ownerSection = isOwnedShareable
    ? '<h4 style="margin-top:18px;">Sharing</h4>' +
      collabList +
      '<div class="inline-form" style="margin-top:8px;">' +
        '<button class="ghost sm" onclick="createBucketInvite(' + jsArg(bucket.id) + ')">Get invite link</button>' +
        publicToggle +
        '<button class="danger sm" onclick="deleteBucket(' + jsArg(bucket.id) + ')">Delete bucket</button>' +
      "</div>" +
      '<h4 style="margin-top:18px;">Key rotation</h4>' +
      '<p class="hint hint-block">Generates a new encryption key, re-encrypts every image in this bucket under it, then revokes the old key for everyone. Use this after removing a collaborator or device you want to make sure can no longer read this bucket.</p>' +
      rotationSection
    : isSharedWithMe
    ? '<p class="hint hint-block" style="margin-top:14px;">Shared by ' + escapeHtml("Account " + String(bucket.owner_id || "").slice(0, 8)) +
      '. You can upload and delete photos and assign this bucket to your own devices, but only the owner can rename, delete, or manage sharing.</p>'
    : !canWrite
    ? '<p class="hint hint-block" style="margin-top:14px;">Public bucket — read-only. You can view its photos and assign it to your own devices, but only its owner can add, delete, rename, or share it.</p>'
    : "";

  const publicPill = bucket.is_public ? '<span class="pill green">Public</span>' : "";
  const sharedPill = isSharedWithMe ? '<span class="pill">Shared</span>' : "";

  const renameButton = isOwnedShareable
    ? '<button class="ghost xs bucket-rename-btn" onclick="startRenameBucket(' + jsArg(bucket.id) + ')">Rename</button>'
    : "";

  const titleRow =
    '<div class="card-head bucket-card-head">' +
      '<div class="bucket-title-main">' +
        "<h3>" + escapeHtml(bucket.label) + "</h3>" +
        renameButton +
      "</div>" +
      '<div class="bucket-meta-pills">' +
        publicPill +
        sharedPill +
        '<span class="pill blue">' + images.length + (images.length === 1 ? " photo" : " photos") + "</span>" +
      "</div>" +
    "</div>";

  return (
    '<div class="card">' +
      titleRow +
      '<div class="photo-grid">' + tiles + addTile + "</div>" +
      ownerSection +
    "</div>"
  );
}

// Toggles is_public on a bucket the caller owns — only ever rendered for a
// superuser owner (see bucketCardHtml's publicToggle) but re-checked
// server-side regardless. Turning ON uploads this bucket's already-unlocked
// raw key as `public_key_raw` (the owner's browser already holds it via its
// own wrapped copy in bucketAesKeys — see root CLAUDE.md's public-buckets
// plan); turning OFF just clears the flag (the Worker nulls public_key_raw).
async function toggleBucketPublic(bucketId: string, makePublic: boolean) {
  if (
    makePublic &&
    !confirm(
      "Make this bucket public? Every account on this server will be able to view its photos (read-only) and assign it to their own devices. This can be undone, but anyone who already has the key keeps read access to images already in the bucket until you rotate the key."
    )
  ) {
    return;
  }
  try {
    const body: { is_public: boolean; public_key_raw?: string } = { is_public: makePublic };
    if (makePublic) {
      const bucketKey = bucketAesKeys.get(bucketId);
      if (!bucketKey) throw new Error("this bucket's key isn't unlocked in this session");
      body.public_key_raw = toBase64(await exportAesKeyRaw(bucketKey));
    }
    await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to update bucket visibility: " + err.message, "error");
  }
}
(window as any).toggleBucketPublic = toggleBucketPublic;

// ---- Upload / crop modal ----

function openUploadModal(deviceKey: string) {
  if (!bucketAesKeys.get(deviceKey)) {
    showMessage("app-message", "This bucket's key isn't unlocked in this session — log out and back in with your passkey.", "error");
    return;
  }
  uploadModalDeviceKey = deviceKey;
  uploadModalFile = null;
  if (uploadObjectUrl) { URL.revokeObjectURL(uploadObjectUrl); uploadObjectUrl = null; }
  cropState = { ...DEFAULT_CROP };
  el("upload-modal-title").textContent = "Add a photo";
  renderUploadDropzone();
  el("upload-modal-overlay").classList.add("open");
}
(window as any).openUploadModal = openUploadModal;

function closeUploadModal() {
  el("upload-modal-overlay").classList.remove("open");
  if (uploadObjectUrl) { URL.revokeObjectURL(uploadObjectUrl); uploadObjectUrl = null; }
  uploadModalFile = null;
}
el("upload-modal-close-btn").addEventListener("click", closeUploadModal);

function renderUploadDropzone() {
  el("upload-modal-body").innerHTML =
    '<label class="dropzone" id="upload-dropzone" for="upload-file-input">' +
      '<span class="plus">+</span>' +
      "Drop a photo here, or click to choose one" +
    "</label>" +
    '<input type="file" id="upload-file-input" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" style="display:none;">';

  const dropzone = el("upload-dropzone");
  const fileInput = el<HTMLInputElement>("upload-file-input");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) selectUploadFile(file);
  });
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) selectUploadFile(file);
  });
}

function selectUploadFile(file: File) {
  uploadModalFile = file;
  cropState = { ...DEFAULT_CROP };
  if (uploadObjectUrl) URL.revokeObjectURL(uploadObjectUrl);
  uploadObjectUrl = URL.createObjectURL(file);
  el("upload-modal-title").textContent = "Position &amp; upload";
  renderUploadCropStage(file.name);
}

function renderUploadCropStage(defaultFilename: string) {
  const ditherOptions = DITHER_ALGORITHMS.map((a) => '<option value="' + a + '">' + a + "</option>").join("");
  el("upload-modal-body").innerHTML =
    '<div class="crop-stage">' +
      '<div class="crop-viewport" id="upload-crop-viewport" style="width:' + CROP_BOX_W + 'px;height:' + CROP_BOX_H + 'px;">' +
        '<img id="upload-crop-img" src="' + uploadObjectUrl + '" alt="">' +
      "</div>" +
      '<div class="crop-controls">' +
        '<p class="crop-hint hint-block">Drag the photo to reposition it, and zoom in if you want to fill the frame differently. The box shows exactly what the display will show.</p>' +
        '<div class="crop-zoom-row">' +
          "<span>Zoom</span>" +
          '<input type="range" id="upload-zoom-slider" min="100" max="300" step="1" value="100">' +
          '<button class="ghost sm" id="upload-crop-reset-btn" type="button">Reset</button>' +
        "</div>" +
        '<div class="row"><label>Filename</label><input type="text" id="upload-filename-input" value="' + escapeHtml(defaultFilename) + '"></div>' +
        '<div class="row"><label>Dither</label><select id="upload-dither-select">' + ditherOptions + "</select></div>" +
        '<button id="upload-confirm-btn">Upload photo</button>' +
      "</div>" +
    "</div>";

  const img = el<HTMLImageElement>("upload-crop-img");
  img.addEventListener("load", () => {
    cropNatural = { w: img.naturalWidth, h: img.naturalHeight };
    layoutCropImage();
  });

  const viewport = el("upload-crop-viewport");
  viewport.addEventListener("pointerdown", onCropPointerDown);
  viewport.addEventListener("pointermove", onCropPointerMove);
  viewport.addEventListener("pointerup", onCropPointerUp);
  viewport.addEventListener("pointercancel", onCropPointerUp);

  el<HTMLInputElement>("upload-zoom-slider").addEventListener("input", (e) => {
    cropState.zoom = Number((e.target as HTMLInputElement).value) / 100;
    layoutCropImage();
  });
  el("upload-crop-reset-btn").addEventListener("click", () => {
    cropState = { ...DEFAULT_CROP };
    el<HTMLInputElement>("upload-zoom-slider").value = "100";
    layoutCropImage();
  });
  el("upload-confirm-btn").addEventListener("click", confirmUpload);
}

// Positions/sizes the crop preview image from cropNatural + cropState, at the
// crop viewport's current (board-dependent) CSS size — see CropParams in
// decode.ts for how panX/panY/zoom map onto the final upright crop (the same
// fractions, just applied at preview resolution instead of full resolution).
function layoutCropImage() {
  if (!cropNatural.w || !cropNatural.h) return;
  const img = el<HTMLImageElement>("upload-crop-img");
  const coverScale = Math.max(CROP_BOX_W / cropNatural.w, CROP_BOX_H / cropNatural.h);
  const scale = coverScale * cropState.zoom;
  const w = cropNatural.w * scale;
  const h = cropNatural.h * scale;
  img.style.width = w + "px";
  img.style.height = h + "px";
  const minLeft = CROP_BOX_W - w;
  const minTop = CROP_BOX_H - h;
  img.style.left = minLeft * cropState.panX + "px";
  img.style.top = minTop * cropState.panY + "px";
}

function onCropPointerDown(e: PointerEvent) {
  const viewport = el("upload-crop-viewport");
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add("dragging");
  const img = el<HTMLImageElement>("upload-crop-img");
  cropDrag = {
    startX: e.clientX,
    startY: e.clientY,
    startLeft: parseFloat(img.style.left) || 0,
    startTop: parseFloat(img.style.top) || 0,
  };
}
function onCropPointerMove(e: PointerEvent) {
  if (!cropDrag) return;
  const img = el<HTMLImageElement>("upload-crop-img");
  const w = img.offsetWidth;
  const h = img.offsetHeight;
  const minLeft = Math.min(0, CROP_BOX_W - w);
  const minTop = Math.min(0, CROP_BOX_H - h);
  const left = Math.min(0, Math.max(minLeft, cropDrag.startLeft + (e.clientX - cropDrag.startX)));
  const top = Math.min(0, Math.max(minTop, cropDrag.startTop + (e.clientY - cropDrag.startY)));
  img.style.left = left + "px";
  img.style.top = top + "px";
  cropState.panX = minLeft === 0 ? 0.5 : left / minLeft;
  cropState.panY = minTop === 0 ? 0.5 : top / minTop;
}
function onCropPointerUp(e: PointerEvent) {
  if (!cropDrag) return;
  cropDrag = null;
  el("upload-crop-viewport").classList.remove("dragging");
  try { el("upload-crop-viewport").releasePointerCapture(e.pointerId); } catch {}
}

/**
 * Decode -> EXIF-correct -> crop (per cropState, from the interactive picker
 * above) -> rotate -> enhance -> dither -> pack -> hash -> encrypt now all run
 * here, client-side — the Worker never sees plaintext (see root CLAUDE.md's
 * encrypted-buckets plan). `packed_hash` is computed over the encrypted
 * packed blob, not the plaintext, since that's the only thing the server can
 * compare on later requests.
 */
async function confirmUpload() {
  const deviceKey = uploadModalDeviceKey;
  const file = uploadModalFile;
  if (!deviceKey || !file) return;
  const filename = (el<HTMLInputElement>("upload-filename-input").value || file.name).trim();
  // Mirrors the server's validateFilename() (lib/validate.ts): the filename is
  // the (bucket, filename) unique key and ends up in the X-Image-Name response
  // header, so control characters and over-long values must never reach it.
  if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
    showMessage("app-message", "Filename must be 1-255 characters with no control characters.", "error");
    return;
  }
  const dither = el<HTMLSelectElement>("upload-dither-select").value as DitherAlgorithm;

  const bucketKey = bucketAesKeys.get(deviceKey);
  if (!bucketKey) {
    showMessage("app-message", "This bucket's key isn't unlocked in this session — log out and back in with your passkey.", "error");
    return;
  }

  const confirmBtn = el<HTMLButtonElement>("upload-confirm-btn");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Processing…";

  try {
    // Never store the original file: re-encode a bounded "storage original"
    // (see decode.ts's resizeForStorage — capped at 2560px long side, JPEG).
    // This is what the lightbox preview decrypts and what a key rotation
    // re-crops from, so both stay bounded and rotation-compatible; the raw
    // camera original never leaves this browser.
    const rawBytes = await resizeForStorage(file);
    const rawCiphertext = await aesGcmEncryptBlob(bucketKey, rawBytes);

    const formData = new FormData();
    formData.set("dither_algorithm", dither);
    formData.set("raw", new Blob([new Uint8Array(rawCiphertext)]), "raw.bin");

    // Bucket-key-keyed hash of the default board's PLAINTEXT packed buffer
    // (see crypto.ts's computeContentHash) — the Worker compares it against
    // the bucket's other images and rejects a duplicate rendition with 409
    // (migrations/0020_image_content_hash.sql). Must be captured before the
    // compress/encrypt steps below, which would make the hash
    // nondeterministic. Holder object because TS can't narrow a plain `let`
    // assigned inside this async closure.
    const contentHash = { value: null as string | null };

    // A bucket isn't board-scoped (migrations/0019_image_board_variants.sql)
    // - every upload generates every board's rendition from this one crop,
    // so any device subscribed to this bucket, whatever its screen, is
    // servable without a second upload.
    await Promise.all(
      BOARD_IDS.map(async (board) => {
        const landscape = await decodeToBoardBuffer(file, cropState, board);
        enhance(landscape.rgba, landscape.width, landscape.height, DEFAULT_BRIGHTNESS, DEFAULT_CONTRAST, DEFAULT_SATURATION);
        const indices = ditherImage(landscape.rgba, landscape.width, landscape.height, dither);
        const packed = packToNibbles(indices);
        if (board === DEFAULT_BOARD_ID) {
          contentHash.value = await computeContentHash(bucketKey, packed);
        }
        const thumbnail = await makeThumbnailJpeg(landscape.upright.rgba, landscape.upright.width, landscape.upright.height);

        // Compress the plaintext packed buffer BEFORE encrypting it -
        // ciphertext doesn't compress meaningfully (see compress.ts's doc
        // comment). Only actually ships the compressed form if it's
        // meaningfully smaller.
        const { bytes: packedForUpload, encoding: packedEncoding } = await compressPackedForUpload(packed);

        const [packedCiphertext, thumbCiphertext] = await Promise.all([
          aesGcmEncryptBlob(bucketKey, packedForUpload),
          aesGcmEncryptBlob(bucketKey, thumbnail),
        ]);
        const packedHash = await computeHash16(packedCiphertext);

        formData.set(`packed_encoding__${board}`, packedEncoding);
        formData.set(`packed_hash__${board}`, packedHash);
        formData.set(`packed__${board}`, new Blob([new Uint8Array(packedCiphertext)]), `packed-${board}.bin`);
        formData.set(`thumb__${board}`, new Blob([new Uint8Array(thumbCiphertext)]), `thumb-${board}.bin`);
      })
    );

    if (contentHash.value) formData.set("content_hash", contentHash.value);

    // No Content-Type header: FormData needs the browser to set its own
    // multipart boundary, which apiFetch only does when we don't override it.
    const uploadUrl =
      "/admin/images/upload?device_key=" + encodeURIComponent(deviceKey) + "&filename=" + encodeURIComponent(filename);
    try {
      await apiFetch(uploadUrl, { method: "POST", body: formData });
    } catch (err: any) {
      // Duplicate rendition (migrations/0020_image_content_hash.sql): say
      // which filename already holds it, and let the user force it through
      // with allow_duplicate=1 — retrying the exact same formData, so the
      // (expensive) decode/dither/encrypt pipeline above doesn't re-run.
      if (err?.status !== 409 || !err?.body?.duplicate_of) throw err;
      const proceed = confirm(
        `This bucket already contains this image as "${err.body.duplicate_of}". Upload it again anyway?`
      );
      if (!proceed) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Upload photo";
        return;
      }
      await apiFetch(uploadUrl + "&allow_duplicate=1", { method: "POST", body: formData });
    }
    closeUploadModal();
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to upload image: " + err.message, "error");
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Upload photo";
  }
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

function renderBucketTitleView(titleMain: HTMLElement, bucket: any) {
  titleMain.classList.remove("editing");
  titleMain.replaceChildren();

  const heading = document.createElement("h3");
  heading.textContent = bucket.label;
  titleMain.appendChild(heading);

  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.className = "ghost xs bucket-rename-btn";
  renameButton.textContent = "Rename";
  renameButton.addEventListener("click", () => startRenameBucket(bucket.id));
  titleMain.appendChild(renameButton);
}

function startRenameBucket(bucketId: string) {
  const bucket = allBucketsCache.find((b) => b.id === bucketId);
  const bucketShell = document.getElementById("bucket-" + bucketId);
  const titleMain = bucketShell?.querySelector<HTMLElement>(".bucket-title-main");
  if (!bucket || !titleMain) return;

  titleMain.classList.add("editing");
  titleMain.replaceChildren();

  const form = document.createElement("form");
  form.className = "bucket-title-edit";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "bucket-title-input";
  input.value = bucket.label || "";
  input.setAttribute("aria-label", "Bucket name");

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.className = "sm";
  saveButton.textContent = "Save";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "ghost sm";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => renderBucketTitleView(titleMain, bucket));

  form.append(input, saveButton, cancelButton);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const label = input.value.trim();
    if (!label) {
      showMessage("app-message", "Bucket name must not be blank.", "error");
      input.focus();
      return;
    }
    if (label.length > 80) {
      showMessage("app-message", "Bucket label must be at most 80 characters.", "error");
      input.focus();
      return;
    }
    if (label === bucket.label) {
      renderBucketTitleView(titleMain, bucket);
      return;
    }

    input.disabled = true;
    saveButton.disabled = true;
    cancelButton.disabled = true;
    try {
      await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      bucket.label = label;
      renderBucketTitleView(titleMain, bucket);
    } catch (err: any) {
      input.disabled = false;
      saveButton.disabled = false;
      cancelButton.disabled = false;
      showMessage("app-message", "Failed to rename bucket: " + err.message, "error");
      input.focus();
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") renderBucketTitleView(titleMain, bucket);
  });

  titleMain.appendChild(form);
  input.focus();
  input.select();
}
(window as any).startRenameBucket = startRenameBucket;

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

// ---- Bucket key rotation ----
// Closes the "no crypto-level revocation" gap in root CLAUDE.md's
// encrypted-buckets plan: POST /admin/buckets/:id/rotate/start et al (see
// routes/admin/buckets.ts) do the bookkeeping, but only this browser can
// actually perform the work, since it's the one holding both the bucket's
// OLD content key (already unwrapped into bucketAesKeys by renderApp) and,
// for the duration of one rotation, the NEW one it either just generated or
// recovered from GET rotate/status's your_new_key. There is deliberately no
// server-side "just re-encrypt it for me" — the whole point of client-side
// encryption is that the Worker never sees plaintext, and rotation is no
// exception: every image is downloaded, decrypted, and re-encrypted here.

function rotateModalUpdate(done: number, total: number, note?: string) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  el("rotate-modal-body").innerHTML =
    "<p>" + done + " of " + total + " images re-encrypted (" + pct + "%).</p>" +
    '<div class="progress-track">' +
      '<div class="progress-fill" style="width:' + pct + '%;"></div>' +
    "</div>" +
    (note ? '<p class="hint" style="margin-top:10px;">' + escapeHtml(note) + "</p>" : "");
}
function rotateModalOpen(done: number, total: number) {
  el("rotate-modal-title").textContent = "Rotating bucket key";
  rotateModalUpdate(done, total);
  el("rotate-modal-overlay").classList.add("open");
}
function rotateModalClose() {
  el("rotate-modal-overlay").classList.remove("open");
}
el("rotate-modal-close-btn").addEventListener("click", rotateModalClose);

/**
 * Re-encrypts one image under `newKey`: fetches and decrypts its raw original
 * (the only ciphertext an admin route exposes — there is no route to fetch an
 * image's already-processed packed/thumb blobs) under `oldKey`, then re-runs
 * the exact decode -> enhance -> dither -> pack -> thumbnail pipeline
 * confirmUpload() uses, so the result is the same processing applied again,
 * not a copy of bytes that happen to already exist. Note this re-crops with
 * the DEFAULT_CROP framing (centered, no zoom): per-image pan/zoom choices
 * made at original upload time aren't persisted anywhere server-side (they're
 * baked directly into the packed pixels, never stored as separate metadata),
 * so there's no way to reproduce a custom crop here — only the pixels for a
 * previously-default-cropped image are guaranteed to come out identical.
 */
async function reencryptOneImage(
  bucketId: string,
  rotationId: string,
  imageId: string,
  ditherAlgorithm: DitherAlgorithm,
  oldKey: CryptoKey,
  newKey: CryptoKey
): Promise<void> {
  const res = await fetch("/admin/images/" + encodeURIComponent(imageId) + "/raw", {
    headers: { Authorization: "Bearer " + getApiKey() },
  });
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  const rawCiphertext = new Uint8Array(await res.arrayBuffer());
  const rawBytes = await aesGcmDecryptBlob(oldKey, rawCiphertext);
  const newRawCiphertext = await aesGcmEncryptBlob(newKey, rawBytes);

  const formData = new FormData();
  formData.set("raw", new Blob([new Uint8Array(newRawCiphertext)]), "raw.bin");

  // Every board's variant gets re-derived and re-uploaded together, same as
  // confirmUpload() - this does NOT try to preserve whatever packed_encoding
  // each variant happened to have before rotation (there's nothing stored
  // server-side to read a "how was this compressed" answer from without the
  // bucket key anyway).
  await Promise.all(
    BOARD_IDS.map(async (board) => {
      const landscape = await decodeToBoardBuffer(new Blob([new Uint8Array(rawBytes)]), DEFAULT_CROP, board);
      enhance(landscape.rgba, landscape.width, landscape.height, DEFAULT_BRIGHTNESS, DEFAULT_CONTRAST, DEFAULT_SATURATION);
      const indices = ditherImage(landscape.rgba, landscape.width, landscape.height, ditherAlgorithm);
      const packed = packToNibbles(indices);
      // Refresh the keyed content hash under the NEW bucket key while the
      // plaintext is in hand (migrations/0020_image_content_hash.sql) — the
      // stored hash must stay comparable with post-rotation uploads, which
      // are keyed with this same new key.
      if (board === DEFAULT_BOARD_ID) {
        formData.set("content_hash", await computeContentHash(newKey, packed));
      }
      const thumbnail = await makeThumbnailJpeg(landscape.upright.rgba, landscape.upright.width, landscape.upright.height);

      const { bytes: packedForUpload, encoding: packedEncoding } = await compressPackedForUpload(packed);

      const [newPackedCiphertext, newThumbCiphertext] = await Promise.all([
        aesGcmEncryptBlob(newKey, packedForUpload),
        aesGcmEncryptBlob(newKey, thumbnail),
      ]);
      const packedHash = await computeHash16(newPackedCiphertext);

      formData.set(`packed_encoding__${board}`, packedEncoding);
      formData.set(`packed_hash__${board}`, packedHash);
      formData.set(`packed__${board}`, new Blob([new Uint8Array(newPackedCiphertext)]), `packed-${board}.bin`);
      formData.set(`thumb__${board}`, new Blob([new Uint8Array(newThumbCiphertext)]), `thumb-${board}.bin`);
    })
  );

  await apiFetch(
    "/admin/buckets/" + encodeURIComponent(bucketId) + "/rotate/" + encodeURIComponent(rotationId) + "/reencrypt-image/" + encodeURIComponent(imageId),
    { method: "POST", body: formData }
  );
}

/**
 * Starts a new rotation, or resumes one found via GET rotate/status (called
 * unconditionally first — covers both an explicit "Resume rotation" click and
 * a stale "Rotate key" click racing another tab that already started one).
 * Drives the whole job in this one call: re-encrypt every pending image, then
 * re-wrap the new key for every currently-listed collaborator and device and
 * finalize. A failure at any point leaves the rotation exactly where it
 * stopped — clicking the button again (this function) resumes from there via
 * rotate/status, it does not restart from scratch.
 */
async function runBucketRotation(bucketId: string) {
  if (!sharingPrivateKey || !sharingPublicKeyRaw) {
    showMessage("app-message", "Log in with your passkey to rotate a bucket's key.", "error");
    return;
  }
  const oldBucketKey = bucketAesKeys.get(bucketId);
  if (!oldBucketKey) {
    showMessage("app-message", "This bucket's key isn't unlocked in this session — log out and back in with your passkey.", "error");
    return;
  }

  let status: any;
  try {
    status = await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId) + "/rotate/status");
  } catch (err: any) {
    showMessage("app-message", "Failed to check rotation status: " + err.message, "error");
    return;
  }

  let rotationId: string;
  let newKeyRaw: Uint8Array;
  let pendingImageIds: string[];
  let doneCount: number;

  if (status.rotation) {
    if (!status.rotation.your_new_key) {
      showMessage(
        "app-message",
        "A rotation is already in progress for this bucket, but this browser session can't recover its new key. Resume it from the browser/account that started it.",
        "error"
      );
      return;
    }
    try {
      newKeyRaw = await unwrapKeyWith(sharingPrivateKey, status.rotation.your_new_key as WrappedKey, HKDF_INFO_BUCKET_WRAP);
    } catch {
      showMessage("app-message", "Failed to unwrap the in-progress rotation's new key.", "error");
      return;
    }
    rotationId = status.rotation.id;
    pendingImageIds = status.rotation.pending_image_ids;
    doneCount = status.rotation.done_image_ids.length;
  } else {
    const proceed = confirm(
      "Rotating this bucket's key re-downloads, re-decrypts, and re-encrypts EVERY image in this bucket (real bandwidth and time for a large bucket), then revokes the old key for anyone/anything not currently a collaborator or assigned device. This cannot be undone once it finishes. Continue?"
    );
    if (!proceed) return;

    const newKey = await generateBucketKey();
    newKeyRaw = await exportAesKeyRaw(newKey);
    const wrappedForSelf = await wrapKeyFor(sharingPublicKeyRaw, newKeyRaw, HKDF_INFO_BUCKET_WRAP);
    try {
      const startResult = await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId) + "/rotate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: wrappedForSelf }),
      });
      rotationId = startResult.rotation_id;
      pendingImageIds = startResult.image_ids;
      doneCount = 0;
    } catch (err: any) {
      showMessage("app-message", "Failed to start rotation: " + err.message, "error");
      return;
    }
  }

  const newKey = await importAesKeyRaw(newKeyRaw);
  const total = doneCount + pendingImageIds.length;

  let imagesById = new Map<string, any>();
  try {
    const imagesResult = await apiFetch("/admin/images?device_key=" + encodeURIComponent(bucketId));
    for (const img of imagesResult.images) imagesById.set(img.id, img);
  } catch (err: any) {
    showMessage("app-message", "Failed to load this bucket's image list: " + err.message, "error");
    return;
  }

  rotateModalOpen(doneCount, total);

  let migrated = doneCount;
  for (const imageId of pendingImageIds) {
    const meta = imagesById.get(imageId);
    if (!meta) { migrated++; continue; } // deleted mid-rotation — nothing left to migrate
    rotateModalUpdate(migrated, total, "Re-encrypting " + meta.filename + "…");
    try {
      await reencryptOneImage(bucketId, rotationId, imageId, meta.dither_algorithm, oldBucketKey, newKey);
    } catch (err: any) {
      rotateModalUpdate(migrated, total, "Failed on " + meta.filename + ": " + err.message);
      showMessage(
        "app-message",
        "Rotation paused: failed to re-encrypt " + meta.filename + " (" + err.message + "). Click Resume rotation to retry.",
        "error"
      );
      return;
    }
    migrated++;
    rotateModalUpdate(migrated, total);
  }

  rotateModalUpdate(total, total, "Re-wrapping the new key for every collaborator and device…");

  try {
    const collaboratorsResult = await apiFetch("/admin/buckets/" + encodeURIComponent(bucketId) + "/collaborators");
    const devicesForBucket = devicesCache.filter((d) => (d.bucket_ids || []).includes(bucketId));

    const userKeys: Record<string, WrappedKey> = {};
    userKeys[currentUser.id] = await wrapKeyFor(sharingPublicKeyRaw, newKeyRaw, HKDF_INFO_BUCKET_WRAP);
    for (const collaborator of collaboratorsResult.collaborators) {
      if (!collaborator.sharing_public_key) {
        throw new Error("collaborator " + (collaborator.display_name || collaborator.id) + " has no sharing key on file yet");
      }
      userKeys[collaborator.id] = await wrapKeyFor(fromBase64(collaborator.sharing_public_key), newKeyRaw, HKDF_INFO_BUCKET_WRAP);
    }

    const deviceKeys: Record<string, WrappedKey> = {};
    for (const device of devicesForBucket) {
      if (!device.sharing_public_key) {
        throw new Error("device " + device.mac + " hasn't reported a sharing key yet");
      }
      deviceKeys[device.mac] = await wrapKeyFor(fromBase64(device.sharing_public_key), newKeyRaw, HKDF_INFO_BUCKET_WRAP);
    }

    // A public bucket's key isn't wrapped for anyone — it's just not kept
    // secret (migrations/0018_public_buckets.sql) — so finalize must also
    // receive the new raw key to store as the new public_key_raw, or every
    // non-owner reader would be stuck decrypting with the now-revoked old
    // key after this rotation completes. newKeyRaw is already in scope here
    // (this same rotation's freshly-generated or -recovered raw key).
    const bucketMeta = allBucketsCache.find((b) => b.id === bucketId);
    const finalizeBody: { user_keys: Record<string, WrappedKey>; device_keys: Record<string, WrappedKey>; public_key_raw?: string } = {
      user_keys: userKeys,
      device_keys: deviceKeys,
    };
    if (bucketMeta && bucketMeta.is_public) {
      finalizeBody.public_key_raw = toBase64(newKeyRaw);
    }

    await apiFetch(
      "/admin/buckets/" + encodeURIComponent(bucketId) + "/rotate/" + encodeURIComponent(rotationId) + "/finalize",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(finalizeBody) }
    );
  } catch (err: any) {
    rotateModalUpdate(total, total, "Failed to finalize: " + err.message);
    showMessage(
      "app-message",
      "Every image was re-encrypted, but finalizing the rotation failed (" + err.message + "). Click Resume rotation to retry finalizing — no images need re-uploading.",
      "error"
    );
    return;
  }

  rotateModalClose();
  showMessage("app-message", "Bucket key rotated — the old key no longer works for anyone.", "success");
  await renderApp();
}
(window as any).runBucketRotation = runBucketRotation;

el("create-bucket-btn").addEventListener("click", async () => {
  const input = el<HTMLInputElement>("new-bucket-label");
  const label = input.value.trim();
  if (!label) return;
  if (label.length > 80) {
    showMessage("app-message", "Bucket label must be at most 80 characters.", "error");
    return;
  }
  if (!sharingPublicKeyRaw) {
    showMessage("app-message", "Can't create an encrypted bucket yet — log out and back in with your passkey first.", "error");
    return;
  }
  try {
    // The bucket's AES-256-GCM content key is generated here, client-side, and
    // never sent to the Worker raw — only this wrap of it for our own key
    // (and, only if this box is checked, ALSO the raw key itself under
    // `public_key_raw` — see migrations/0018_public_buckets.sql). The
    // checkbox itself only exists in the DOM for a superuser (see
    // renderPublicBucketCheckbox below) but the Worker re-checks
    // is_superuser regardless of what the client sends.
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);
    const key = await wrapKeyFor(sharingPublicKeyRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const makePublicCheckbox = el<HTMLInputElement>("new-bucket-public-checkbox");
    const body: { label: string; key: WrappedKey; is_public?: boolean; public_key_raw?: string } = { label, key };
    if (makePublicCheckbox.checked) {
      body.is_public = true;
      body.public_key_raw = toBase64(bucketKeyRaw);
    }
    await apiFetch("/admin/buckets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    input.value = "";
    makePublicCheckbox.checked = false;
    await renderApp();
  } catch (err: any) {
    showMessage("app-message", "Failed to create bucket: " + err.message, "error");
  }
});

// Shows the "Make this public" checkbox only for a superuser (see
// GET /admin/me's is_superuser field) — everyone else never sees it, since
// they have no ability to use it anyway (the Worker rejects is_public: true
// from a non-superuser with 403).
function renderPublicBucketCheckboxVisibility() {
  el("new-bucket-public-row").style.display = currentUser && currentUser.is_superuser ? "" : "none";
}

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
        '<td><button class="ghost" onclick="clearFirmwareTarget(' + jsArg(t.target) + ')">Clear</button></td>' +
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

// Only pop the register modal open automatically once per page load — renderApp()
// (and so renderClaimBanner()) re-runs after basically every action, and forcing
// the modal back open on each of those while ?claim= is still in the URL would be
// intrusive rather than helpful.
let claimModalAutoOpened = false;

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
    '<button class="sm" onclick="openRegisterModal()">Register it&hellip;</button>' +
    "</div>";
  el<HTMLInputElement>("new-device-mac").value = claimMac;
  if (!claimModalAutoOpened) {
    claimModalAutoOpened = true;
    openRegisterModal();
    el("new-device-label").focus();
  }
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
    '<button onclick="joinBucket(' + jsArg(token) + ')">Join</button>' +
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
  // Needs devicesCache/allBucketsCache populated (openBucketModal reads both) —
  // unlike renderClaimBanner/renderJoinBucketBanner above, which don't.
  renderAssignBucketBanner();

  // Unwrap every bucket's content key this session can access, before
  // rendering anything that needs to decrypt a thumbnail. A bucket this
  // account can see but has no usable key for (sharingPrivateKey not
  // unlocked, or a stale/corrupt wrap) just renders without thumbnails —
  // see decryptToObjectUrl's callers below.
  bucketAesKeys.clear();
  // Buckets with neither a personal `key` nor a `public_key_raw` (a public
  // bucket this account has no personal wrap for is still `public_key_raw`-
  // only) render without thumbnails/decryption below — same "leave this one
  // undecryptable" fallback as an unwrap failure.
  for (const b of allBucketsCache) {
    if (!b.key && b.public_key_raw) {
      // Public bucket (migrations/0018_public_buckets.sql): the raw key
      // simply isn't kept secret, so there's nothing to unwrap — import it
      // directly instead of going through unwrapKeyWith/sharingPrivateKey.
      try {
        bucketAesKeys.set(b.id, await importAesKeyRaw(fromBase64(b.public_key_raw)));
      } catch (err) {
        console.error(`Failed to import bucket ${b.id}'s public_key_raw:`, err);
      }
    }
  }
  if (sharingPrivateKey) {
    await Promise.all(allBucketsCache.map(async (b) => {
      if (!b.key) return;
      try {
        const raw = await unwrapKeyWith(sharingPrivateKey!, b.key as WrappedKey, HKDF_INFO_BUCKET_WRAP);
        bucketAesKeys.set(b.id, await importAesKeyRaw(raw));
      } catch (err) {
        // Leave this one bucket undecryptable rather than fail the whole render —
        // but still surface it, since a silent failure here is exactly what makes
        // "this bucket's key isn't unlocked" reports impossible to diagnose.
        console.error(`Failed to unwrap bucket ${b.id}'s key with the current session key:`, err);
      }
    }));
  } else if (allBucketsCache.some((b) => b.key)) {
    // A plain reload only resumes the cached API key (see tryLogin) — it
    // can't recover a PRF-backed sharing key on its own, so this needs an
    // actual passkey ceremony rather than just a login/reload retry. Build
    // the button directly (not via showMessage, which escapes its text)
    // since it needs to stay clickable.
    el("app-message").innerHTML =
      '<div class="message error">' +
      "Encrypted bucket contents are locked. " +
      '<button class="sm" onclick="unlockSharingKey()">Unlock with passkey</button>' +
      "</div>";
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

  // Split into three groups:
  //  - "My buckets" (is_owner true — an owned bucket that's ALSO public stays
  //    here with a Public pill via bucketCardHtml, rather than moving to the
  //    read-only section — the owner keeps full controls over it either way).
  //  - "Shared with me" (not owned, but this account holds a personal wrapped
  //    key — i.e. an accepted collaborator via bucket_shares/join()).
  //  - "Public buckets" (visible only because is_public = 1, no personal
  //    wrap — see bucketHasWriteAccess).
  const myBuckets = allBucketsCache.filter((b) => b.is_owner);
  const sharedBuckets = allBucketsCache.filter((b) => !b.is_owner && bucketHasWriteAccess(b));
  const publicBuckets = allBucketsCache.filter((b) => !bucketHasWriteAccess(b));

  el("buckets-mine-heading").style.display = myBuckets.length ? "" : "none";
  el("buckets-shared-heading").style.display = sharedBuckets.length ? "" : "none";
  el("buckets-shared-hint").style.display = sharedBuckets.length ? "" : "none";
  el("buckets-public-heading").style.display = publicBuckets.length ? "" : "none";
  el("buckets-public-hint").style.display = publicBuckets.length ? "" : "none";

  const bucketsMineEl = el("buckets-mine");
  bucketsMineEl.innerHTML = myBuckets.map((b) => '<div id="bucket-' + b.id + '"></div>').join("");
  const bucketsSharedEl = el("buckets-shared");
  bucketsSharedEl.innerHTML = sharedBuckets.map((b) => '<div id="bucket-' + b.id + '"></div>').join("");
  const bucketsPublicEl = el("buckets-public");
  bucketsPublicEl.innerHTML = publicBuckets.map((b) => '<div id="bucket-' + b.id + '"></div>').join("");

  await Promise.all(allBucketsCache.map(async (b) => {
    const isOwnedShareable = b.is_owner;
    const [imagesResult, collaboratorsResult, rotationStatusResult] = await Promise.all([
      apiFetch("/admin/images?device_key=" + encodeURIComponent(b.id)),
      isOwnedShareable
        ? apiFetch("/admin/buckets/" + encodeURIComponent(b.id) + "/collaborators")
        : Promise.resolve({ collaborators: [] }),
      // Only the owner can call rotate/status (rotation is owner-only) — lets
      // a browser reloaded mid-rotation discover and resume it on load
      // rather than only on an explicit click.
      isOwnedShareable
        ? apiFetch("/admin/buckets/" + encodeURIComponent(b.id) + "/rotate/status").catch(() => ({ rotation: null }))
        : Promise.resolve({ rotation: null }),
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
      collaboratorsResult.collaborators,
      rotationStatusResult.rotation
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
