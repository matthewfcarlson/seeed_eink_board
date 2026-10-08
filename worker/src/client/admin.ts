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
  deriveKekFromRecoveryCode,
  exportAesKeyRaw,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  fromBase64,
  formatRecoveryCode,
  fromBase64Url,
  generateBucketKey,
  generateP256KeyPair,
  generateRecoveryCodeBytes,
  importAesKeyRaw,
  computeContentHash,
  importPrivateKeyPkcs8,
  parseRecoveryCode,
  publicKeyRawFromPrivateKey,
  toBase64,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyFor,
  type WrappedKey,
} from "./crypto";
import { DEFAULT_CROP, decodeToBoardBuffer, resizeForStorage, type CropParams } from "./decode";
import { PIPELINE_DITHER_NAME, computeHash16, enhanceAndDither, packToNibbles } from "../lib/dither";
import { BOARD_IDS, DEFAULT_BOARD_ID, IMAGE_PIPELINE_VERSION, type BoardId } from "../lib/media-constants";
import { compressPackedForUpload } from "./compress";
import { makeCroppedSourceJpeg, makeThumbnailJpeg } from "./thumbnail";
import { renderDisplayPreview } from "./display-preview";
import { localKeystoreGet, localKeystoreSet } from "./keystore";
import { computeSharingKeyProof, type SharingKeyProofPurpose } from "../lib/sharing-key-proof";

const KEY_STORAGE = "eink_admin_api_key";
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
// Why the last passkey attempt couldn't unlock this browser (a
// SharingKeyLockedError's message), shown under "Details" in the locked
// banner — null when there's no failed attempt to explain yet.
let sharingKeyLockedDetail: string | null = null;
// bucketId -> that bucket's unwrapped AES-256-GCM content key, populated by
// renderApp() from each bucket's caller-specific WrappedKey.
const bucketAesKeys = new Map<string, CryptoKey>();

// CSS size of the crop viewport (see .crop-viewport in style.css) — EE02's
// upright (pre-rotation) 3:4 ratio (1200x1600). A bucket isn't board-scoped
// (migrations/0019_image_board_variants.sql) and processAndUploadImage()/
// reencryptOneImage() always crop+pack for every board from this one
// interactive crop, so there's one reference box for the preview rather than
// a per-board one: the same panX/panY/zoom fractions this box produces are
// applied independently against each other board's own upright target in
// decode.ts's decodeToBoardBuffer — a reasonable approximation for boards
// with a different aspect ratio (EE04's upright crop is 3:5, not 3:4), not a
// second crop UI.
const CROP_BOX_W = 210;
const CROP_BOX_H = 280;

// One entry per photo picked in the upload modal. Each keeps its own crop,
// filename and dither, so every photo in a multi-select gets positioned
// individually; confirmed items process/upload one at a time in the
// background (uploadChain) while you crop the next one.
type UploadQueueItem = {
  deviceKey: string;
  file: File;
  objectUrl: string;
  crop: CropParams;
  filename: string;
  // pending: still waiting to be cropped. queued/uploading: confirmed, in
  // uploadChain. skipped: declined at the duplicate-image prompt.
  status: "pending" | "queued" | "uploading" | "done" | "skipped" | "error";
  error?: string;
};
let uploadModalDeviceKey: string | null = null;
let uploadQueue: UploadQueueItem[] = [];
let uploadCurrent: UploadQueueItem | null = null;
let uploadChain: Promise<void> = Promise.resolve();
let cropNatural = { w: 0, h: 0 };
// Aliases uploadCurrent.crop while a photo is on the crop stage, so the
// drag/zoom handlers below write straight into that queue item.
let cropState: CropParams = { ...DEFAULT_CROP };
// Upload modal's "Preview on display" toggle (client/display-preview.ts).
// Stays on across queue items once turned on. `displayPreviewSeq` drops a
// render that finished after a newer one was requested.
let displayPreviewOn = false;
let displayPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let displayPreviewSeq = 0;
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
// Named "ApiKey" for the storage key and these helpers because the wire format
// (`eink_…` bearer string) never changed — only what mints/validates it did
// (single users.api_key_hash → per-login user_sessions rows). Rebranding the
// localStorage key would log every browser out for zero functional gain.
function setApiKey(key: string) { localStorage.setItem(KEY_STORAGE, key); }
function clearApiKey() { localStorage.removeItem(KEY_STORAGE); }
/** Alias used at the ceremony call sites, where the server field is now
 *  `session_token` — keeps grep honest in both directions. */
const setSessionToken = setApiKey;

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

// #app-message is a fixed toast (style.css), so a failure from a form far down
// the page is still seen. Errors stay until dismissed; anything else fades.
const messageTimers: Record<string, number> = {};
function showMessage(elId: string, text: string, kind: string) {
  const target = el(elId);
  clearTimeout(messageTimers[elId]);
  target.innerHTML = text
    ? '<div class="message ' + kind + '" role="' + (kind === "error" ? "alert" : "status") + '">' +
      '<span class="message-text">' + escapeHtml(text) + "</span>" +
      '<button type="button" class="message-close" aria-label="Dismiss">&times;</button></div>'
    : "";
  target.querySelector(".message-close")?.addEventListener("click", () => showMessage(elId, "", ""));
  if (text && elId === "app-message" && kind !== "error") {
    messageTimers[elId] = window.setTimeout(() => showMessage(elId, "", ""), 8000);
  }
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

/** Thrown by completeLoginSharingKey when the ceremony (and so the session)
 *  succeeded but the account's sharing key can't be recovered in this browser.
 *  Callers should carry on into the app — buckets stay locked behind the
 *  "Unlock with passkey" banner — rather than treat it as a failed login. */
class SharingKeyLockedError extends Error {}

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
): Promise<Partial<{ sharing_public_key: string; wrapped_sharing_key: string; wrap_nonce: string; repair: boolean }>> {
  const prfOutput = readPrfOutput(credential);

  // Set when this ceremony DID produce PRF output but it didn't open this
  // credential's wrap — distinct from "no PRF output at all", and worth a
  // different error message if the local cache can't cover for it either.
  let prfUnwrapFailed = false;

  if (loginResult.wrapped_sharing_key && loginResult.sharing_public_key && prfOutput) {
    // The wrap on file is this credential's own (the server returns the
    // logging-in credential's row), so in theory the same PRF salt yields the
    // same bytes every time. In practice it has been seen to fail — Safari
    // surfaces it as a bare WebCrypto OperationError ("The operation failed
    // for an operation-specific reason"). UV can't be the cause (the server
    // requires it on every ceremony); an authenticator returning different
    // PRF output at create() vs get() is the leading suspect. Either way it
    // used to abort the whole login even though the ceremony itself succeeded
    // and the session was already minted. Treat it as "no usable PRF wrap
    // this time" and fall through to the local-cache path: if this browser has
    // ever unlocked the account before, its IndexedDB copy is still good.
    try {
      const kek = await deriveKekFromPrf(prfOutput);
      const privateKeyPkcs8 = await aesGcmDecryptFromStrings(kek, loginResult.wrap_nonce, loginResult.wrapped_sharing_key);
      sharingPrivateKey = await importPrivateKeyPkcs8(privateKeyPkcs8);
      sharingPublicKeyRaw = fromBase64(loginResult.sharing_public_key);
      await localKeystoreSet({ publicKeyRaw: sharingPublicKeyRaw, privateKeyPkcs8 });
      return {};
    } catch (err) {
      prfUnwrapFailed = true;
      console.warn(
        "Couldn't recover the account's PRF-wrapped sharing key with this ceremony's PRF output " +
        "(unwrap, import, or local caching failed). Falling back to this browser's locally cached key, if any.",
        err
      );
    }
  }

  // No usable PRF-wrapped key from the server this time (either none exists
  // yet, or this ceremony didn't yield a PRF result) — fall back to whatever
  // this browser has cached locally.
  const local = await localKeystoreGet();
  if (local) {
    sharingPrivateKey = await importPrivateKeyPkcs8(local.privateKeyPkcs8);
    sharingPublicKeyRaw = local.publicKeyRaw;
    if (loginResult.sharing_public_key && toBase64(local.publicKeyRaw) !== loginResult.sharing_public_key) {
      // Not fatal (buckets were unlocked with this key before), but nothing
      // wrapped for the account's registered key will open here — say so
      // somewhere greppable instead of failing later with per-bucket errors.
      console.warn(
        "This browser's cached sharing key doesn't match the account's registered sharing_public_key. " +
        "Bucket unlocks will fail here until the browser holding the original key re-wraps or rotates."
      );
      // And never backfill it: the server's IS NULL guard would make this
      // credential's wrap of the WRONG key permanent, so every later PRF login
      // from any browser would "successfully" recover a mismatched key.
      return {};
    }
    if (prfOutput && prfUnwrapFailed) {
      // This browser holds the account's real key, but the wrap on file
      // doesn't open with the PRF output this passkey returns now — seen
      // with iCloud Keychain, whose create()-time PRF result (what the wrap
      // was made from at signup) differs from its get()-time result. Every
      // other browser on this passkey would be locked out, so replace the
      // wrap with one made from this get()'s output. Needs a possession
      // proof server-side (see repairCredentialWrap) since it overwrites.
      const kek = await deriveKekFromPrf(prfOutput);
      const { nonce, ciphertext } = await aesGcmEncryptToStrings(kek, local.privateKeyPkcs8);
      return { sharing_public_key: toBase64(local.publicKeyRaw), wrapped_sharing_key: ciphertext, wrap_nonce: nonce, repair: true };
    }
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
    // Reaching here means this browser has never unlocked this account before
    // (no IndexedDB cache) AND the PRF path didn't work — either this ceremony
    // produced no PRF result at all (cross-device QR/hybrid auth and some
    // platform authenticators commonly don't), or it did but that output
    // couldn't open the wrap on file. Different causes, different advice.
    //
    // The message is the "Details" text under the locked banner (see
    // renderLockedBanner), not the headline — keep it technical but short.
    const detail = prfUnwrapFailed
      ? "Your passkey returned a PRF result, but it didn't open the key stored for this passkey. " +
        "Logging in once with your passkey from a browser that's already unlocked repairs this automatically."
      : "Your passkey didn't return a PRF result (common when signing in with a QR code from another device). " +
        "Trying again with this device's own passkey sometimes works.";
    throw new SharingKeyLockedError(detail);
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
    setSessionToken(result.session_token);
    alert("Account created! Your session token (also saved to this browser, shown once):\n\n" + result.session_token);
    await tryLogin(true);
  } catch (err: any) {
    showMessage("login-message", "Failed to create account: " + err.message, "error");
  }
});

type SharingKeyWrapFields = { sharing_public_key: string; wrapped_sharing_key: string; wrap_nonce: string };

/** Proves to the Worker that this browser holds the account's sharing private
 *  key (lib/sharing-key-proof.ts) — required by the endpoints that overwrite
 *  a wrap, so a session token alone can't. */
async function proveSharingKeyPossession(purpose: SharingKeyProofPurpose): Promise<{ challenge_id: string; proof: string }> {
  if (!sharingPrivateKey) throw new Error("This browser isn't unlocked");
  const challenge = await apiFetch("/admin/me/sharing-key/challenge", { method: "POST" });
  const proof = await computeSharingKeyProof(sharingPrivateKey, fromBase64(challenge.server_public_key), challenge.challenge_id, purpose);
  return { challenge_id: challenge.challenge_id, proof: toBase64(proof) };
}

async function repairCredentialWrap(credentialId: string, fields: SharingKeyWrapFields): Promise<void> {
  const proof = await proveSharingKeyPossession("repair-credential-wrap");
  await apiFetch("/admin/me/sharing-key/repair", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: credentialId, ...fields, ...proof }),
  });
  console.info("Repaired this passkey's stored sharing-key wrap — other browsers using this passkey can now unlock.");
}

// The actual WebAuthn login ceremony, shared by the pre-login "Log in with
// passkey" button and unlockSharingKey() below — the latter runs it again
// for an already-logged-in-via-cached-API-key session that never got a
// sharing key, since a fresh PRF result is only ever available mid-ceremony
// (there's no way to request just PRF without a full assertion). Re-running
// it for an already-authenticated account is harmless: it just re-verifies
// the same passkey and overwrites the cached token with an equivalent one —
// old sessions stay active (see routes/admin/sessions.ts for revocation).
async function performPasskeyLoginCeremony(): Promise<void> {
  const { attemptId, options } = await publicFetch("/auth/login/options", {});
  const requestOptions = (window as any).PublicKeyCredential.parseRequestOptionsFromJSON(options);
  ensurePrfExtensionInput(requestOptions);
  const credential: any = await navigator.credentials.get({ publicKey: requestOptions });
  const loginResult = await publicFetch("/auth/login/verify", { attemptId, response: credential.toJSON() });
  setSessionToken(loginResult.session_token);
  sharingKeyLockedDetail = null;
  const { repair, ...backfillFields } = await completeLoginSharingKey(credential, loginResult);
  if (repair) {
    // Best-effort like the backfill below: if it fails, this browser is
    // still unlocked from its local cache and the next login retries.
    repairCredentialWrap(credential.id, backfillFields as SharingKeyWrapFields).catch((err) =>
      console.warn("Couldn't repair this passkey's stored sharing-key wrap:", err)
    );
  } else if (Object.keys(backfillFields).length > 0) {
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
    if (err instanceof SharingKeyLockedError) {
      // The session token is already set — enter the app with buckets locked.
      // renderApp() shows the locked banner, with this as its details.
      sharingKeyLockedDetail = err.message;
      await tryLogin(true);
      return;
    }
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
    sharingKeyLockedDetail = err instanceof SharingKeyLockedError ? err.message : "Passkey sign-in failed: " + err.message;
    renderLockedBanner();
  }
}
(window as any).unlockSharingKey = unlockSharingKey;

/** The "this browser isn't unlocked yet" banner: shown when the account has
 *  encrypted buckets but this session has no sharing key. A plain reload
 *  only resumes the cached API key (see tryLogin) — it can't recover a
 *  PRF-backed sharing key on its own, so unlocking needs either an actual
 *  passkey ceremony or the account's recovery code. Built as raw HTML (not
 *  showMessage, which escapes) since its buttons need to stay clickable;
 *  the only interpolated text is escaped. */
function renderLockedBanner() {
  const banner = el("locked-banner");
  if (sharingPrivateKey || !allBucketsCache.some((b) => b.key)) {
    banner.innerHTML = "";
    return;
  }
  const detail = sharingKeyLockedDetail ??
    "Your photos are encrypted in your browser before upload, and each browser needs to unlock your key once. " +
    "A plain page reload can't do that on its own.";
  banner.innerHTML =
    '<div class="message info locked-banner">' +
    "<strong>This browser isn't unlocked yet.</strong> " +
    "Your photos are end-to-end encrypted, so you'll need to unlock them here before you can view or delete them." +
    '<div class="locked-actions">' +
    '<button class="sm" onclick="unlockSharingKey()">Unlock with passkey</button>' +
    '<button class="sm subtle" onclick="openRecoveryUnlockModal()">Use recovery code</button>' +
    "</div>" +
    "<details><summary>Details</summary><p>" + escapeHtml(detail) + "</p></details>" +
    "</div>";
}

function recoveryNudgeDismissKey(): string {
  return "eink_recovery_nudge_dismissed:" + (currentUser?.id ?? "");
}

/** Nudges an unlocked account with no recovery code to make one — the only
 *  moment one CAN be made, since the code wraps the private key this browser
 *  holds. Dismissal is per-browser (localStorage); the Account card keeps
 *  the button either way. */
function renderRecoveryNudge() {
  renderRecoveryStatus();
  const banner = el("recovery-banner");
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(recoveryNudgeDismissKey()) === "1";
  } catch {}
  if (!sharingPrivateKey || !currentUser || currentUser.has_recovery_code || !currentUser.sharing_public_key || dismissed) {
    banner.innerHTML = "";
    return;
  }
  banner.innerHTML =
    '<div class="message info locked-banner">' +
    "<strong>Create a recovery code.</strong> " +
    "If your passkey can't unlock your photos on another device, a recovery code can." +
    '<div class="locked-actions">' +
    '<button class="sm" onclick="openRecoveryCreateModal()">Create recovery code</button>' +
    '<button class="sm ghost" onclick="dismissRecoveryNudge()">Not now</button>' +
    "</div></div>";
}

function dismissRecoveryNudge() {
  try {
    localStorage.setItem(recoveryNudgeDismissKey(), "1");
  } catch {}
  el("recovery-banner").innerHTML = "";
}
(window as any).dismissRecoveryNudge = dismissRecoveryNudge;

/** The Account card's recovery-code line + button. */
function renderRecoveryStatus() {
  const status = el("recovery-status");
  const btn = el<HTMLButtonElement>("recovery-create-btn");
  if (!currentUser) return;
  btn.textContent = currentUser.has_recovery_code ? "Replace recovery code" : "Create recovery code";
  btn.disabled = !sharingPrivateKey;
  status.textContent = !sharingPrivateKey
    ? "Unlock this browser first to create or replace a recovery code."
    : currentUser.has_recovery_code
      ? "A recovery code is set up. Replacing it makes the old one stop working."
      : "No recovery code yet. It lets you unlock your photos on a device where your passkey can't.";
}

let pendingRecoveryCodeBytes: Uint8Array | null = null;

function closeRecoveryModal() {
  pendingRecoveryCodeBytes = null;
  el("recovery-modal-overlay").classList.remove("open");
  el("recovery-modal-body").innerHTML = "";
}
el("recovery-modal-close-btn").addEventListener("click", closeRecoveryModal);

/** Generates a code and shows it, but only uploads its wrap once the user
 *  confirms they saved it — so backing out never replaces a working code. */
function openRecoveryCreateModal() {
  if (!sharingPrivateKey) {
    showMessage("app-message", "Unlock this browser first to create a recovery code.", "error");
    return;
  }
  pendingRecoveryCodeBytes = generateRecoveryCodeBytes();
  const code = formatRecoveryCode(pendingRecoveryCodeBytes);
  el("recovery-modal-title").textContent = currentUser?.has_recovery_code ? "Replace recovery code" : "Your recovery code";
  el("recovery-modal-body").innerHTML =
    '<p class="hint hint-block">Save this somewhere safe, like a password manager. Anyone with this code and access to your account can see your photos. ' +
    "We can't show it again or recover it for you.</p>" +
    (currentUser?.has_recovery_code ? '<p class="hint hint-block">Saving this replaces your current recovery code, which will stop working.</p>' : "") +
    '<div class="recovery-code" id="recovery-code-text">' + escapeHtml(code) + "</div>" +
    '<button class="subtle sm" id="recovery-copy-btn">Copy</button>' +
    '<div class="row checkbox-row" style="margin-top:14px;">' +
    '<input type="checkbox" id="recovery-saved-checkbox"><label for="recovery-saved-checkbox">I\'ve saved this code somewhere safe</label></div>' +
    '<div id="recovery-modal-message"></div>' +
    '<div class="inline-form" style="margin-top:16px;">' +
    '<button id="recovery-save-btn" disabled>Save recovery code</button>' +
    '<button class="ghost" id="recovery-cancel-btn">Cancel</button></div>';
  el("recovery-copy-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      el("recovery-copy-btn").textContent = "Copied";
    } catch {
      // Clipboard can be blocked (permissions, non-secure context) — fall
      // back to selecting the text so a manual copy is one keystroke.
      const range = document.createRange();
      range.selectNodeContents(el("recovery-code-text"));
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });
  el<HTMLInputElement>("recovery-saved-checkbox").addEventListener("change", (e) => {
    el<HTMLButtonElement>("recovery-save-btn").disabled = !(e.target as HTMLInputElement).checked;
  });
  el("recovery-cancel-btn").addEventListener("click", closeRecoveryModal);
  el("recovery-save-btn").addEventListener("click", saveRecoveryCode);
  el("recovery-modal-overlay").classList.add("open");
}
(window as any).openRecoveryCreateModal = openRecoveryCreateModal;
el("recovery-create-btn").addEventListener("click", openRecoveryCreateModal);

async function saveRecoveryCode() {
  if (!pendingRecoveryCodeBytes || !sharingPrivateKey) return;
  const btn = el<HTMLButtonElement>("recovery-save-btn");
  btn.disabled = true;
  try {
    const kek = await deriveKekFromRecoveryCode(pendingRecoveryCodeBytes);
    const { nonce, ciphertext } = await aesGcmEncryptToStrings(kek, await exportPrivateKeyPkcs8(sharingPrivateKey));
    const proof = await proveSharingKeyPossession("set-recovery-wrap");
    await apiFetch("/admin/me/recovery-wrap", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrapped_sharing_key: ciphertext, wrap_nonce: nonce, ...proof }),
    });
    currentUser.has_recovery_code = true;
    closeRecoveryModal();
    renderRecoveryNudge();
    showMessage("app-message", "Recovery code saved.", "success");
  } catch (err: any) {
    btn.disabled = false;
    const message = err.status === 403
      ? "This browser's key doesn't match your account's, so it can't set a recovery code. Try from the browser where you created your account."
      : "Couldn't save the recovery code: " + err.message;
    showMessage("recovery-modal-message", message, "error");
  }
}

function openRecoveryUnlockModal() {
  el("recovery-modal-title").textContent = "Unlock with recovery code";
  el("recovery-modal-body").innerHTML =
    '<p class="hint hint-block">Paste the recovery code you saved (it starts with RC1-).</p>' +
    '<input type="text" id="recovery-code-input" placeholder="RC1-XXXX-XXXX-…" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
    '<div id="recovery-modal-message" style="margin-top:12px;"></div>' +
    '<div class="inline-form" style="margin-top:16px;">' +
    '<button id="recovery-unlock-btn">Unlock</button>' +
    '<button class="ghost" id="recovery-cancel-btn">Cancel</button></div>';
  el("recovery-cancel-btn").addEventListener("click", closeRecoveryModal);
  el("recovery-unlock-btn").addEventListener("click", unlockWithRecoveryCode);
  el<HTMLInputElement>("recovery-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockWithRecoveryCode();
  });
  el("recovery-modal-overlay").classList.add("open");
  el<HTMLInputElement>("recovery-code-input").focus();
}
(window as any).openRecoveryUnlockModal = openRecoveryUnlockModal;

async function unlockWithRecoveryCode() {
  const codeBytes = parseRecoveryCode(el<HTMLInputElement>("recovery-code-input").value);
  if (!codeBytes) {
    showMessage("recovery-modal-message", "That doesn't look like a recovery code. It should be RC1- followed by 32 letters and numbers.", "error");
    return;
  }
  const btn = el<HTMLButtonElement>("recovery-unlock-btn");
  btn.disabled = true;
  try {
    let wrap: any;
    try {
      wrap = await apiFetch("/admin/me/recovery-wrap");
    } catch (err: any) {
      if (err.status === 404) throw new Error("This account doesn't have a recovery code set up yet.");
      throw err;
    }
    let privateKeyPkcs8: Uint8Array;
    try {
      privateKeyPkcs8 = await aesGcmDecryptFromStrings(await deriveKekFromRecoveryCode(codeBytes), wrap.wrap_nonce, wrap.wrapped_sharing_key);
    } catch {
      throw new Error("That recovery code doesn't match this account. Check for typos, or use your newest code if you've replaced it.");
    }
    const privateKey = await importPrivateKeyPkcs8(privateKeyPkcs8);
    const publicKeyRaw = await publicKeyRawFromPrivateKey(privateKey);
    if (currentUser?.sharing_public_key && toBase64(publicKeyRaw) !== currentUser.sharing_public_key) {
      throw new Error("That recovery code unlocked a key that isn't this account's current key — it may be from before a reset.");
    }
    sharingPrivateKey = privateKey;
    sharingPublicKeyRaw = publicKeyRaw;
    sharingKeyLockedDetail = null;
    // Cache it like every other recovery path (see completeLoginSharingKey),
    // so reloads stay unlocked — and so the next passkey login here can
    // repair this passkey's PRF wrap from it if that's what was broken.
    await localKeystoreSet({ publicKeyRaw, privateKeyPkcs8 });
    closeRecoveryModal();
    await renderApp();
    showMessage("app-message", "Unlocked with your recovery code.", "success");
  } catch (err: any) {
    btn.disabled = false;
    showMessage("recovery-modal-message", err.message, "error");
  }
}

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
  setSessionToken(key);
  await tryLogin(true);
});

el("logout-btn").addEventListener("click", async () => {
  // Revoke server-side before dropping the local copy — if the request fails
  // (offline, already revoked) still clear locally: a dead token in storage
  // is worse than a live one we failed to revoke (the user can re-run logout
  // or "sign out other devices" from any session).
  try {
    await apiFetch("/admin/sessions/current", { method: "DELETE" });
  } catch {
    // fall through to local cleanup regardless
  }
  clearApiKey();
  el("app").style.display = "none";
  el("login").style.display = "block";
});

el("rotate-key-btn").addEventListener("click", async () => {
  if (!confirm("Sign out all other devices/browsers? This browser stays logged in; every other session's token stops working immediately.")) return;
  try {
    const result = await apiFetch("/admin/sessions/revoke-others", { method: "POST" });
    alert("Signed out " + result.revoked + " other session(s). This browser is still logged in.");
  } catch (err: any) {
    showMessage("app-message", "Failed to sign out other sessions: " + err.message, "error");
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
      // Only on a real first claim — a label-only edit of an already-owned
      // device leaves its Firmware-panel channel alone (the server does too
      // when auto_update is omitted).
      body.auto_update = el<HTMLInputElement>("new-device-auto-update").checked;
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
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No devices registered yet &mdash; add one below.</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map((d) => {
    const battery = d.last_battery_voltage != null ? batteryPillHtml(d.last_battery_voltage) : '<span class="hint">n/a</span>';
    const lastSeen = d.last_seen_at
      ? '<span title="' + escapeHtml(new Date(d.last_seen_at * 1000).toLocaleString()) +
        (d.last_seen_ip ? " · " + escapeHtml(d.last_seen_ip) : "") + '">' +
        formatRelativeTime(d.last_seen_at) + "</span>"
      : '<span class="hint">never</span>';
    // Same evaluation the hourly alert check runs server-side (lib/device-health.ts).
    const overdue = d.health && d.health.offline
      ? ' <span class="pill red" title="Missed its expected check-in' + (d.alerts_muted ? " (alerts muted)" : "") + '">overdue</span>'
      : "";
    const firmware = d.running_firmware_version
      ? escapeHtml(d.running_firmware_version)
      : '<span class="hint">unknown</span>';
    const board = d.board
      ? '<span class="pill" title="MAC ' + escapeHtml(d.mac) + '">' + escapeHtml(d.board) + "</span>"
      : '<span class="hint" title="MAC ' + escapeHtml(d.mac) + '">unknown</span>';
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
      "<td>" + lastSeen + overdue + "</td>" +
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

async function deleteImage(id: string, bucketId: string) {
  if (!confirm("Delete this image? This cannot be undone.")) return;
  try {
    await apiFetch("/admin/images/" + encodeURIComponent(id), { method: "DELETE" });
    if (thumbnailUrlCache[id]) {
      URL.revokeObjectURL(thumbnailUrlCache[id]);
      delete thumbnailUrlCache[id];
    }
    await refreshBucket(bucketId);
  } catch (err: any) {
    showMessage("app-message", "Failed to delete image: " + err.message, "error");
  }
}
(window as any).deleteImage = deleteImage;

// Re-renders a single bucket card in place (re-fetching just its images/
// collaborators/rotation status) instead of the full renderApp() — a full
// re-render re-fetches and rebuilds every bucket, which with dozens of
// buckets is slow and, because it briefly collapses the buckets containers
// to empty placeholders while everything reloads, shifts page height enough
// to reset scroll position. Falls back to renderApp() if the bucket isn't in
// allBucketsCache (stale cache, race with some other change).
async function refreshBucket(bucketId: string) {
  const bucket = allBucketsCache.find((b) => b.id === bucketId);
  if (!bucket) {
    await renderApp();
    return;
  }
  const isOwnedShareable = bucket.is_owner;
  const [imagesResult, collaboratorsResult, rotationStatusResult] = await Promise.all([
    apiFetch("/admin/images?device_key=" + encodeURIComponent(bucket.id)),
    isOwnedShareable
      ? apiFetch("/admin/buckets/" + encodeURIComponent(bucket.id) + "/collaborators")
      : Promise.resolve({ collaborators: [] }),
    isOwnedShareable
      ? apiFetch("/admin/buckets/" + encodeURIComponent(bucket.id) + "/rotate/status").catch(() => ({ rotation: null }))
      : Promise.resolve({ rotation: null }),
  ]);
  await Promise.all(
    imagesResult.images
      .filter((img: any) => img.thumbnail_ciphertext_b64 && !thumbnailUrlCache[img.id])
      .map(async (img: any) => {
        const url = await decryptToObjectUrl(bucket.id, img.thumbnail_ciphertext_b64);
        if (url) thumbnailUrlCache[img.id] = url;
      })
  );
  el("bucket-" + bucket.id).innerHTML = bucketCardHtml(
    bucket,
    imagesResult.images,
    collaboratorsResult.collaborators,
    rotationStatusResult.rotation
  );
}

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

// Small badge on a photo tile whose variants came from an older version of
// the image pipeline (migrations/0029_image_pipeline_version.sql). The
// title says what re-uploading would gain; version 1 is the only old one so
// far, and what it lacks is a saved crop.
function outdatedPipelineBadge(img: any): string {
  const version = Number(img.pipeline_version ?? 1);
  if (version >= IMAGE_PIPELINE_VERSION) return "";
  const title =
    "Processed by an older version of the image pipeline (v" + version + ", current v" + IMAGE_PIPELINE_VERSION + "). " +
    (version < 2 ? "Its crop wasn't saved and its preview may be the wrong shape. " : "") +
    "Re-upload it to use the latest processing.";
  return '<span class="photo-tile-outdated" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">&#8635;</span>';
}

function bucketCardHtml(bucket: any, images: any[], collaborators: any[], rotation: any | null): string {
  const canWrite = bucketHasWriteAccess(bucket);
  const tiles = images
    .map((img) => {
      const thumb = thumbnailUrlCache[img.id]
        ? '<img src="' + thumbnailUrlCache[img.id] + '" alt="">'
        : '<div class="photo-tile-empty hint">no preview</div>';
      const deleteBtn = canWrite
        ? '<button class="icon-btn photo-tile-delete" aria-label="Delete photo" onclick="event.stopPropagation(); deleteImage(' + jsArg(img.id) + ', ' + jsArg(bucket.id) + ')">&#10005;</button>'
        : "";
      return (
        '<div class="photo-tile" onclick="openLightbox(' + jsArg(img.id) + ', ' + jsArg(bucket.id) + ', ' + jsArg(img.filename) + ')">' +
          thumb +
          '<div class="photo-tile-badges">' +
            outdatedPipelineBadge(img) +
          "</div>" +
          deleteBtn +
          '<div class="photo-tile-caption">' + escapeHtml(img.filename) + "</div>" +
        "</div>"
      );
    })
    .join("");

  // Offered only to accounts that can write (the re-render replaces blobs);
  // a read-only viewer of a public bucket still sees the badges.
  const outdatedCount = images.filter(isOutdatedImage).length;
  const rerenderSection =
    canWrite && outdatedCount > 0
      ? '<div class="rerender-row">' +
          '<span class="hint"><span class="photo-tile-outdated inline" aria-hidden="true">&#8635;</span> ' +
            outdatedCount + (outdatedCount === 1 ? " photo was" : " photos were") + " made with older image processing.</span>" +
          '<button class="ghost sm" onclick="rerenderOutdatedImages(' + jsArg(bucket.id) + ')">Re-render ' +
            (outdatedCount === 1 ? "it" : "them") + "&hellip;</button>" +
        "</div>"
      : "";

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
      rerenderSection +
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

const isUploadInFlight = (i: UploadQueueItem) => i.status === "queued" || i.status === "uploading";

function openUploadModal(deviceKey: string) {
  if (!bucketAesKeys.get(deviceKey)) {
    showMessage("app-message", "This bucket's key isn't unlocked in this session — log out and back in with your passkey.", "error");
    return;
  }
  uploadModalDeviceKey = deviceKey;
  // Uploads still running from an earlier visit keep going regardless (they
  // hold their own item); only this bucket's stay visible in the strip.
  resetUploadQueue((i) => isUploadInFlight(i) && i.deviceKey === deviceKey);
  renderUploadModal();
  el("upload-modal-overlay").classList.add("open");
}
(window as any).openUploadModal = openUploadModal;

function closeUploadModal() {
  el("upload-modal-overlay").classList.remove("open");
  // Un-confirmed photos are discarded; confirmed ones finish in the background.
  resetUploadQueue(isUploadInFlight);
}
el("upload-modal-close-btn").addEventListener("click", closeUploadModal);

function resetUploadQueue(keep: (i: UploadQueueItem) => boolean) {
  for (const item of uploadQueue) {
    if (!keep(item)) URL.revokeObjectURL(item.objectUrl);
  }
  uploadQueue = uploadQueue.filter(keep);
  uploadCurrent = null;
}

// Picks whichever view fits the queue: the dropzone when it's empty, the crop
// stage while a photo is waiting to be positioned, otherwise a progress view.
function renderUploadModal() {
  if (uploadCurrent) {
    el("upload-modal-title").textContent = "Position & upload";
    renderUploadCropStage(uploadCurrent);
  } else if (uploadQueue.length) {
    el("upload-modal-title").textContent = "Uploading photos";
    renderUploadProgress();
  } else {
    el("upload-modal-title").textContent = "Add photos";
    renderUploadDropzone();
  }
}

const UPLOAD_FILE_INPUT =
  '<input type="file" id="upload-file-input" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" style="display:none;">';

function bindUploadFileInput() {
  const fileInput = el<HTMLInputElement>("upload-file-input");
  fileInput.addEventListener("change", () => {
    addFilesToUploadQueue(Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });
}

function renderUploadDropzone() {
  el("upload-modal-body").innerHTML =
    '<label class="dropzone" id="upload-dropzone" for="upload-file-input">' +
      '<span class="plus">+</span>' +
      "Drop photos here, or click to choose some" +
    "</label>" +
    UPLOAD_FILE_INPUT;

  const dropzone = el("upload-dropzone");
  bindUploadFileInput();
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    addFilesToUploadQueue(Array.from(e.dataTransfer?.files ?? []));
  });
}

// The filename is the bucket's (device_key, filename) unique key and a
// re-upload under the same name replaces that image, so two queued photos
// that happen to share a name (IMG_0001.jpg from two cameras) get suffixed
// rather than silently overwriting each other.
function uniqueQueueFilename(deviceKey: string, name: string): string {
  const taken = new Set(uploadQueue.filter((i) => i.deviceKey === deviceKey).map((i) => i.filename));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = base + " (" + n + ")" + ext;
    if (!taken.has(candidate)) return candidate;
  }
}

function addFilesToUploadQueue(files: File[]) {
  const deviceKey = uploadModalDeviceKey;
  if (!deviceKey) return;
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  saveUploadCropForm();
  const added = images.map((file): UploadQueueItem => {
    const item: UploadQueueItem = {
      deviceKey,
      file,
      objectUrl: URL.createObjectURL(file),
      crop: { ...DEFAULT_CROP },
      filename: "",
      status: "pending",
    };
    item.filename = uniqueQueueFilename(deviceKey, file.name);
    uploadQueue.push(item);
    return item;
  });
  if (!uploadCurrent) uploadCurrent = added[0] ?? null;
  renderUploadModal();
}

// Copies the crop stage's filename input back into the item being edited,
// before anything switches away from it.
function saveUploadCropForm() {
  if (!uploadCurrent) return;
  const nameInput = document.getElementById("upload-filename-input") as HTMLInputElement | null;
  if (nameInput) uploadCurrent.filename = nameInput.value.trim() || uploadCurrent.file.name;
}

function uploadQueueStripHtml(): string {
  if (uploadQueue.length < 2) return "";
  const labels: Record<UploadQueueItem["status"], string> = {
    pending: "", queued: "Waiting", uploading: "Uploading…", done: "✓", skipped: "Skipped", error: "Failed — click to retry",
  };
  return uploadQueue.map((item, idx) =>
    '<button type="button" class="upload-queue-item status-' + item.status + (item === uploadCurrent ? " current" : "") +
      '" data-idx="' + idx + '" title="' + escapeHtml(item.error ? item.filename + ": " + item.error : item.filename) + '">' +
      '<img src="' + item.objectUrl + '" alt="" loading="lazy" decoding="async">' +
      (labels[item.status] ? '<span class="upload-queue-badge">' + labels[item.status] + "</span>" : "") +
    "</button>"
  ).join("");
}

function uploadQueueSummary(): string {
  const count = (s: UploadQueueItem["status"]) => uploadQueue.filter((i) => i.status === s).length;
  const parts: string[] = [];
  const pending = count("pending");
  const inFlight = count("queued") + count("uploading");
  if (pending) parts.push(pending + " to position");
  if (inFlight) parts.push(inFlight + " uploading");
  if (count("done")) parts.push(count("done") + " uploaded");
  if (count("skipped")) parts.push(count("skipped") + " skipped");
  if (count("error")) parts.push(count("error") + " failed");
  return parts.join(" · ");
}

// Re-renders just the thumbnail strip + summary line, so background upload
// progress never resets the crop stage mid-drag.
function refreshUploadQueueStrip() {
  const strip = document.getElementById("upload-queue-strip");
  if (strip) strip.innerHTML = uploadQueueStripHtml();
  const summary = document.getElementById("upload-queue-summary");
  if (summary) summary.textContent = uploadQueueSummary();
}

function bindUploadQueueStrip() {
  el("upload-queue-strip").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".upload-queue-item");
    if (!btn) return;
    const item = uploadQueue[Number(btn.dataset.idx)];
    if (!item || item === uploadCurrent) return;
    if (item.status === "error" || item.status === "skipped") {
      item.status = "pending";
      item.error = undefined;
    }
    if (item.status !== "pending") return;
    saveUploadCropForm();
    uploadCurrent = item;
    renderUploadModal();
  });
}

function renderUploadProgress() {
  const failed = uploadQueue.filter((i) => i.status === "error");
  el("upload-modal-body").innerHTML =
    '<div class="upload-queue" id="upload-queue-strip">' + uploadQueueStripHtml() + "</div>" +
    '<p class="hint" id="upload-queue-summary">' + uploadQueueSummary() + "</p>" +
    (failed.length
      ? '<p class="hint">Click a failed photo to adjust it and try again.</p>'
      : '<p class="hint">You can close this window — uploads keep going in the background.</p>') +
    '<div class="upload-actions">' +
      '<label class="btn ghost" for="upload-file-input">Add more photos</label>' +
      '<button type="button" id="upload-done-btn">Close</button>' +
    "</div>" +
    UPLOAD_FILE_INPUT;
  bindUploadQueueStrip();
  bindUploadFileInput();
  el("upload-done-btn").addEventListener("click", closeUploadModal);
}

function renderUploadCropStage(item: UploadQueueItem) {
  cropState = item.crop;
  cropNatural = { w: 0, h: 0 };
  const pendingOthers = uploadQueue.filter((i) => i.status === "pending" && i !== item).length;
  el("upload-modal-body").innerHTML =
    '<div class="upload-queue" id="upload-queue-strip">' + uploadQueueStripHtml() + "</div>" +
    '<div class="crop-stage">' +
      '<div class="crop-viewport" id="upload-crop-viewport" style="width:' + CROP_BOX_W + 'px;height:' + CROP_BOX_H + 'px;">' +
        '<img id="upload-crop-img" src="' + item.objectUrl + '" alt="">' +
        '<canvas id="upload-preview-canvas" class="crop-preview stale"' + (displayPreviewOn ? "" : " hidden") + "></canvas>" +
      "</div>" +
      '<div class="crop-controls">' +
        '<p class="crop-hint hint-block">Drag the photo to reposition it, and zoom in if you want to fill the frame differently. The box shows exactly what the display will show.</p>' +
        '<div class="crop-zoom-row">' +
          "<span>Zoom</span>" +
          '<input type="range" id="upload-zoom-slider" min="100" max="300" step="1" value="' + Math.round(item.crop.zoom * 100) + '">' +
          '<button class="ghost sm" id="upload-crop-reset-btn" type="button">Reset</button>' +
        "</div>" +
        '<div class="row"><label>Filename</label><input type="text" id="upload-filename-input" value="' + escapeHtml(item.filename) + '"></div>' +
        '<div class="crop-preview-row">' +
          '<button class="ghost sm" id="upload-preview-btn" type="button" aria-pressed="' + displayPreviewOn + '">' +
            (displayPreviewOn ? "Show photo" : "Preview on display") +
          "</button>" +
          '<span class="hint" id="upload-preview-status">' + (displayPreviewOn ? "Rendering&hellip;" : "") + "</span>" +
        "</div>" +
        '<div class="upload-actions">' +
          '<button id="upload-confirm-btn">' + (pendingOthers ? "Upload &amp; next" : "Upload photo") + "</button>" +
          (pendingOthers
            ? '<button class="ghost" id="upload-all-btn" type="button">Upload all ' + (pendingOthers + 1) + "</button>"
            : "") +
        "</div>" +
        '<div class="upload-actions">' +
          '<label class="btn ghost sm" for="upload-file-input">Add more</label>' +
          (uploadQueue.length > 1 ? '<button class="subtle sm" id="upload-remove-btn" type="button">Remove this photo</button>' : "") +
        "</div>" +
        '<p class="hint" id="upload-queue-summary">' + (uploadQueue.length > 1 ? uploadQueueSummary() : "") + "</p>" +
      "</div>" +
    "</div>" +
    UPLOAD_FILE_INPUT;

  bindUploadQueueStrip();
  bindUploadFileInput();

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
    scheduleDisplayPreview();
  });
  el("upload-crop-reset-btn").addEventListener("click", () => {
    Object.assign(cropState, DEFAULT_CROP);
    el<HTMLInputElement>("upload-zoom-slider").value = "100";
    layoutCropImage();
    scheduleDisplayPreview();
  });
  el("upload-preview-btn").addEventListener("click", () => {
    displayPreviewOn = !displayPreviewOn;
    const btn = el("upload-preview-btn");
    btn.textContent = displayPreviewOn ? "Show photo" : "Preview on display";
    btn.setAttribute("aria-pressed", String(displayPreviewOn));
    el("upload-preview-canvas").hidden = !displayPreviewOn;
    el("upload-preview-status").textContent = "";
    if (displayPreviewOn) scheduleDisplayPreview(0);
  });
  if (displayPreviewOn) scheduleDisplayPreview(0);
  el("upload-confirm-btn").addEventListener("click", confirmUpload);
  document.getElementById("upload-all-btn")?.addEventListener("click", confirmUploadAll);
  document.getElementById("upload-remove-btn")?.addEventListener("click", () => {
    if (!uploadCurrent) return;
    const removed = uploadCurrent;
    const next = nextPendingUploadItem(removed);
    uploadQueue = uploadQueue.filter((i) => i !== removed);
    URL.revokeObjectURL(removed.objectUrl);
    uploadCurrent = next;
    renderUploadModal();
  });
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
  scheduleDisplayPreview();
}

// Re-renders the display preview after the crop changes, debounced
// so dragging the zoom slider doesn't queue a full-resolution dither per
// step. Meanwhile the preview is marked stale (CSS hides it, so the photo
// underneath shows the new framing live).
function scheduleDisplayPreview(delayMs = 300) {
  if (!displayPreviewOn) return;
  document.getElementById("upload-preview-canvas")?.classList.add("stale");
  if (displayPreviewTimer) clearTimeout(displayPreviewTimer);
  displayPreviewTimer = setTimeout(() => {
    displayPreviewTimer = null;
    void renderUploadDisplayPreview();
  }, delayMs);
}

async function renderUploadDisplayPreview() {
  const item = uploadCurrent;
  if (!item || !displayPreviewOn) return;
  const seq = ++displayPreviewSeq;
  const status = document.getElementById("upload-preview-status");
  if (status) status.textContent = "Rendering…";
  try {
    // The crop box is the reference board's (EE02's 3:4) shape, so that's
    // the board previewed - see root CLAUDE.md's crop-UI known gap.
    const image = await renderDisplayPreview(item.file, { ...cropState }, DEFAULT_BOARD_ID);
    const canvas = document.getElementById("upload-preview-canvas") as HTMLCanvasElement | null;
    // A newer render was requested, or the modal moved on to another photo.
    if (seq !== displayPreviewSeq || !canvas || uploadCurrent !== item) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    canvas.classList.remove("stale");
    const statusNow = document.getElementById("upload-preview-status");
    if (statusNow) statusNow.textContent = "Simulated panel colors (approximate)";
  } catch (err: any) {
    if (seq !== displayPreviewSeq) return;
    const statusNow = document.getElementById("upload-preview-status");
    if (statusNow) statusNow.textContent = "Preview failed: " + err.message;
  }
}

// Next photo still waiting to be positioned, preferring the ones after
// `from` in queue order and wrapping around to earlier skips.
function nextPendingUploadItem(from: UploadQueueItem): UploadQueueItem | null {
  const idx = uploadQueue.indexOf(from);
  const ordered = [...uploadQueue.slice(idx + 1), ...uploadQueue.slice(0, Math.max(idx, 0))];
  return ordered.find((i) => i.status === "pending" && i !== from) ?? null;
}

// Mirrors the server's validateFilename() (lib/validate.ts): the filename is
// the (bucket, filename) unique key and ends up in the X-Image-Name response
// header, so control characters and over-long values must never reach it.
function isValidUploadFilename(filename: string): boolean {
  return !!filename && filename.length <= 255 && !/[\u0000-\u001f\u007f]/.test(filename);
}

function confirmUpload() {
  const item = uploadCurrent;
  if (!item) return;
  saveUploadCropForm();
  if (!isValidUploadFilename(item.filename)) {
    showMessage("app-message", "Filename must be 1-255 characters with no control characters.", "error");
    return;
  }
  enqueueUpload(item);
  uploadCurrent = nextPendingUploadItem(item);
  renderUploadModal();
}

// Queues every remaining photo as-is: ones you haven't touched go up with the
// default centered crop.
function confirmUploadAll() {
  saveUploadCropForm();
  const pending = uploadQueue.filter((i) => i.status === "pending");
  const invalid = pending.find((i) => !isValidUploadFilename(i.filename));
  if (invalid) {
    uploadCurrent = invalid;
    renderUploadModal();
    showMessage("app-message", `"${invalid.filename}" isn't a valid filename (1-255 characters, no control characters).`, "error");
    return;
  }
  for (const item of pending) enqueueUpload(item);
  uploadCurrent = null;
  renderUploadModal();
}

// Uploads run strictly one at a time: each one decodes/dithers every board's
// rendition at full resolution, and doing several at once would multiply
// that memory for no real speedup on the main thread.
function enqueueUpload(item: UploadQueueItem) {
  item.status = "queued";
  item.error = undefined;
  uploadChain = uploadChain.then(() => runQueuedUpload(item));
}

async function runQueuedUpload(item: UploadQueueItem) {
  if (item.status !== "queued") return;
  item.status = "uploading";
  refreshUploadQueueStrip();
  try {
    item.status = (await processAndUploadImage(item)) ? "done" : "skipped";
  } catch (err: any) {
    item.status = "error";
    item.error = err?.message ?? String(err);
  }
  refreshUploadQueueStrip();
  if (uploadQueue.some(isUploadInFlight)) return;

  // Batch drained: refresh just the buckets that received a photo, once,
  // not after every photo — and not the full renderApp(), which rebuilds
  // every bucket and resets scroll position (see refreshBucket).
  const failed = uploadQueue.filter((i) => i.status === "error");
  const touchedBuckets = new Set(uploadQueue.filter((i) => i.status === "done").map((i) => i.deviceKey));
  try {
    await Promise.all([...touchedBuckets].map((bucketId) => refreshBucket(bucketId)));
  } catch (err: any) {
    showMessage("app-message", "Uploaded, but failed to refresh the bucket: " + err.message, "error");
  }
  if (failed.length) {
    showMessage(
      "app-message",
      "Failed to upload " + failed.map((i) => '"' + i.filename + '" (' + i.error + ")").join(", "),
      "error"
    );
  }
  const modalOpen = el("upload-modal-overlay").classList.contains("open");
  if (!modalOpen) {
    resetUploadQueue(() => false);
  } else if (!uploadCurrent) {
    if (failed.length) renderUploadModal();
    else closeUploadModal();
  }
}

/**
 * Decode -> EXIF-correct -> crop (per the item's crop, from the interactive
 * picker above) -> rotate -> enhance -> dither -> pack -> hash -> encrypt now
 * all run here, client-side — the Worker never sees plaintext (see root
 * CLAUDE.md's encrypted-buckets plan). `packed_hash` is computed over the
 * encrypted packed blob, not the plaintext, since that's the only thing the
 * server can compare on later requests. Returns false if the user declined
 * to re-upload a duplicate.
 */
async function processAndUploadImage(item: UploadQueueItem): Promise<boolean> {
  const { deviceKey, file, filename } = item;
  const crop = { ...item.crop };
  const bucketKey = bucketAesKeys.get(deviceKey);
  if (!bucketKey) {
    throw new Error("this bucket's key isn't unlocked in this session — log out and back in with your passkey");
  }

  // Never store the original file: re-encode a bounded "storage original"
  // (see decode.ts's resizeForStorage — capped at 2560px long side, JPEG).
  // This is what the lightbox preview decrypts and what a key rotation
  // re-crops from, so both stay bounded and rotation-compatible; the raw
  // camera original never leaves this browser.
  const rawBytes = await resizeForStorage(file);
  const rawCiphertext = await aesGcmEncryptBlob(bucketKey, rawBytes);

  const formData = new FormData();
  formData.set("dither_algorithm", PIPELINE_DITHER_NAME);
  formData.set("raw", new Blob([new Uint8Array(rawCiphertext)]), "raw.bin");
  formData.set("pipeline_version", String(IMAGE_PIPELINE_VERSION));

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
      const landscape = await decodeToBoardBuffer(file, crop, board);
      // Both come from the upright crop BEFORE enhance() touches anything:
      // the cropped source (migrations/0028_image_cropped_source.sql) is what
      // a later re-render or key rotation starts from, so it must hold the
      // user's framing without this pipeline's color tweaks baked in.
      const { upright } = landscape;
      const [thumbnail, croppedSource] = await Promise.all([
        makeThumbnailJpeg(upright.rgba, upright.width, upright.height),
        makeCroppedSourceJpeg(upright.rgba, upright.width, upright.height),
      ]);
      const indices = enhanceAndDither(landscape.rgba, landscape.width, landscape.height);
      const packed = packToNibbles(indices);
      if (board === DEFAULT_BOARD_ID) {
        contentHash.value = await computeContentHash(bucketKey, packed);
      }

      // Compress the plaintext packed buffer BEFORE encrypting it -
      // ciphertext doesn't compress meaningfully (see compress.ts's doc
      // comment). Only actually ships the compressed form if it's
      // meaningfully smaller.
      const { bytes: packedForUpload, encoding: packedEncoding } = await compressPackedForUpload(packed);

      const [packedCiphertext, thumbCiphertext, croppedCiphertext] = await Promise.all([
        aesGcmEncryptBlob(bucketKey, packedForUpload),
        aesGcmEncryptBlob(bucketKey, thumbnail),
        aesGcmEncryptBlob(bucketKey, croppedSource),
      ]);
      const packedHash = await computeHash16(packedCiphertext);

      formData.set(`packed_encoding__${board}`, packedEncoding);
      formData.set(`packed_hash__${board}`, packedHash);
      formData.set(`packed__${board}`, new Blob([new Uint8Array(packedCiphertext)]), `packed-${board}.bin`);
      formData.set(`thumb__${board}`, new Blob([new Uint8Array(thumbCiphertext)]), `thumb-${board}.bin`);
      formData.set(`cropped__${board}`, new Blob([new Uint8Array(croppedCiphertext)]), `cropped-${board}.bin`);
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
      `This bucket already contains "${filename}" as "${err.body.duplicate_of}". Upload it again anyway?`
    );
    if (!proceed) return false;
    await apiFetch(uploadUrl + "&allow_duplicate=1", { method: "POST", body: formData });
  }
  return true;
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

// Progress modal shared by key rotation and re-rendering ("N of M images
// <verb>"). The DOM ids keep their original rotate-modal names.
let progressModalVerb = "re-encrypted";
function progressModalUpdate(done: number, total: number, note?: string) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  el("rotate-modal-body").innerHTML =
    "<p>" + done + " of " + total + " images " + progressModalVerb + " (" + pct + "%).</p>" +
    '<div class="progress-track">' +
      '<div class="progress-fill" style="width:' + pct + '%;"></div>' +
    "</div>" +
    (note ? '<p class="hint" style="margin-top:10px;">' + escapeHtml(note) + "</p>" : "");
}
function progressModalOpen(title: string, verb: string, done: number, total: number) {
  el("rotate-modal-title").textContent = title;
  progressModalVerb = verb;
  progressModalUpdate(done, total);
  el("rotate-modal-overlay").classList.add("open");
}
function rotateModalUpdate(done: number, total: number, note?: string) {
  progressModalUpdate(done, total, note);
}
function rotateModalOpen(done: number, total: number) {
  progressModalOpen("Rotating bucket key", "re-encrypted", done, total);
}
function rotateModalClose() {
  el("rotate-modal-overlay").classList.remove("open");
}
el("rotate-modal-close-btn").addEventListener("click", rotateModalClose);

/** Fetches and decrypts one board's stored cropped source (a JPEG), or null
 *  when the image has none - see GET /admin/images/:id/cropped/:board. */
async function fetchCroppedSource(imageId: string, board: BoardId, key: CryptoKey): Promise<Uint8Array | null> {
  const res = await fetch("/admin/images/" + encodeURIComponent(imageId) + "/cropped/" + encodeURIComponent(board), {
    headers: { Authorization: "Bearer " + getApiKey() },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw httpError(res);
  return aesGcmDecryptBlob(key, new Uint8Array(await res.arrayBuffer()));
}

/**
 * Re-encrypts one image under `newKey`: fetches and decrypts its raw original
 * and per-board cropped sources (there is no route to fetch an image's
 * already-processed packed/thumb blobs) under `oldKey`, then re-runs
 * the exact decode -> enhance -> dither -> pack -> thumbnail pipeline
 * processAndUploadImage() uses, so the result is the same processing applied again,
 * not a copy of bytes that happen to already exist. Each board starts from
 * that board's stored cropped source when there is one (migrations/
 * 0028_image_cropped_source.sql), which keeps the user's original pan/zoom.
 * An image uploaded before cropped sources existed has none, so it's
 * re-cropped from the raw original with DEFAULT_CROP (centered, no zoom) and
 * that crop is stored as its cropped source from here on.
 */
async function reencryptOneImage(
  bucketId: string,
  rotationId: string,
  imageId: string,
  oldKey: CryptoKey,
  newKey: CryptoKey
): Promise<void> {
  const rawBytes = await fetchRawOriginal(imageId, oldKey);
  const newRawCiphertext = await aesGcmEncryptBlob(newKey, rawBytes);

  const formData = new FormData();
  formData.set("raw", new Blob([new Uint8Array(newRawCiphertext)]), "raw.bin");
  await renderStoredImageVariants(formData, imageId, oldKey, newKey, async () => rawBytes);

  await apiFetch(
    "/admin/buckets/" + encodeURIComponent(bucketId) + "/rotate/" + encodeURIComponent(rotationId) + "/reencrypt-image/" + encodeURIComponent(imageId),
    { method: "POST", body: formData }
  );
}

/** Fetches and decrypts an image's raw original (the storage-sized JPEG from
 *  decode.ts's resizeForStorage). */
async function fetchRawOriginal(imageId: string, key: CryptoKey): Promise<Uint8Array> {
  const res = await fetch("/admin/images/" + encodeURIComponent(imageId) + "/raw", {
    headers: { Authorization: "Bearer " + getApiKey() },
  });
  if (!res.ok) throw httpError(res);
  return aesGcmDecryptBlob(key, new Uint8Array(await res.arrayBuffer()));
}

/** Same error shape apiFetch throws (status, and the rate-limit message),
 *  for the raw fetch() calls that download binary blobs. */
function httpError(res: Response): Error & { status: number } {
  const retryAfter = res.headers.get("Retry-After");
  const message =
    res.status === 429 ? "rate limited" + (retryAfter ? ` — retry in ${retryAfter}s` : "") : res.status + " " + res.statusText;
  const err = new Error(message) as Error & { status: number };
  err.status = res.status;
  return err;
}

/**
 * Runs one step of a bulk job (re-rendering or re-encrypting one photo),
 * waiting out a 429 and retrying instead of failing the whole job. Safe
 * because the rate limiter rejects before a route writes anything, and both
 * steps are idempotent anyway. The wait comes from the error's "retry in
 * Ns" (Retry-After); `onWait` lets the caller show it in the progress modal.
 */
async function withRateLimitRetry<T>(step: () => Promise<T>, onWait: (seconds: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (err: any) {
      if (err?.status !== 429 || attempt >= 10) throw err;
      const match = /retry in (\d+)s/.exec(String(err.message));
      const seconds = Math.min(300, Math.max(1, match ? Number(match[1]) : 30)) + 1;
      onWait(seconds);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }
}

/**
 * Re-runs the current pipeline for an image that's already stored, filling
 * `formData` with every board's packed/thumb/cropped ciphertext plus
 * content_hash and pipeline_version — shared by key rotation
 * (reencryptOneImage) and the gallery's re-render (rerenderOneImage). Stored
 * blobs are decrypted with `readKey` and the results encrypted with
 * `writeKey` (the same key for a re-render).
 *
 * Each board starts from its stored cropped source when there is one
 * (migrations/0028_image_cropped_source.sql), which keeps the user's
 * pan/zoom. A board without one is re-cropped from the raw original with
 * DEFAULT_CROP (centered, no zoom) and that crop becomes its cropped source.
 * `getRawOriginal` is only called in that case, so a caller can make the
 * raw download lazy.
 *
 * Every board's variant gets re-derived together, same as
 * processAndUploadImage() - this does NOT try to preserve whatever
 * packed_encoding each variant had before (there's nothing stored
 * server-side to read a "how was this compressed" answer from without the
 * bucket key anyway).
 */
async function renderStoredImageVariants(
  formData: FormData,
  imageId: string,
  readKey: CryptoKey,
  writeKey: CryptoKey,
  getRawOriginal: () => Promise<Uint8Array>
): Promise<void> {
  formData.set("pipeline_version", String(IMAGE_PIPELINE_VERSION));
  await Promise.all(
    BOARD_IDS.map(async (board) => {
      // The stored crop is already exactly this board's upright size, so
      // decodeToBoardBuffer's cover-fit is a 1:1 draw - DEFAULT_CROP only
      // matters on the raw-original fallback.
      const storedCrop = await fetchCroppedSource(imageId, board, readKey);
      const source = storedCrop ?? (await getRawOriginal());
      const landscape = await decodeToBoardBuffer(new Blob([new Uint8Array(source)]), DEFAULT_CROP, board);
      const { upright } = landscape;
      const [thumbnail, croppedSource] = await Promise.all([
        makeThumbnailJpeg(upright.rgba, upright.width, upright.height),
        // Re-encrypt the stored crop's exact bytes rather than re-encoding
        // it - no generational JPEG loss on every rotation/re-render.
        storedCrop ?? makeCroppedSourceJpeg(upright.rgba, upright.width, upright.height),
      ]);
      const indices = enhanceAndDither(landscape.rgba, landscape.width, landscape.height);
      const packed = packToNibbles(indices);
      // Refresh the keyed content hash under the write key while the
      // plaintext is in hand (migrations/0020_image_content_hash.sql) — the
      // stored hash must stay comparable with later uploads keyed the same way.
      if (board === DEFAULT_BOARD_ID) {
        formData.set("content_hash", await computeContentHash(writeKey, packed));
      }

      const { bytes: packedForUpload, encoding: packedEncoding } = await compressPackedForUpload(packed);

      const [packedCiphertext, thumbCiphertext, croppedCiphertext] = await Promise.all([
        aesGcmEncryptBlob(writeKey, packedForUpload),
        aesGcmEncryptBlob(writeKey, thumbnail),
        aesGcmEncryptBlob(writeKey, croppedSource),
      ]);
      const packedHash = await computeHash16(packedCiphertext);

      formData.set(`packed_encoding__${board}`, packedEncoding);
      formData.set(`packed_hash__${board}`, packedHash);
      formData.set(`packed__${board}`, new Blob([new Uint8Array(packedCiphertext)]), `packed-${board}.bin`);
      formData.set(`thumb__${board}`, new Blob([new Uint8Array(thumbCiphertext)]), `thumb-${board}.bin`);
      formData.set(`cropped__${board}`, new Blob([new Uint8Array(croppedCiphertext)]), `cropped-${board}.bin`);
    })
  );
}

/** Re-renders one already-stored image with the current pipeline, under the
 *  bucket's current key (POST /admin/images/:id/rerender). The raw original
 *  is only downloaded if some board has no stored crop to start from. */
async function rerenderOneImage(imageId: string, key: CryptoKey, keyVersion: number): Promise<void> {
  let rawPromise: Promise<Uint8Array> | null = null;
  const getRawOriginal = () => (rawPromise ??= fetchRawOriginal(imageId, key));

  const formData = new FormData();
  formData.set("key_version", String(keyVersion));
  await renderStoredImageVariants(formData, imageId, key, key, getRawOriginal);
  await apiFetch("/admin/images/" + encodeURIComponent(imageId) + "/rerender", { method: "POST", body: formData });
}

function isOutdatedImage(img: any): boolean {
  return Number(img.pipeline_version ?? 1) < IMAGE_PIPELINE_VERSION;
}

/**
 * The bucket card's "Re-render N older photos" button: re-runs the current
 * pipeline over every image whose pipeline_version is behind
 * (migrations/0029_image_pipeline_version.sql), one at a time with the
 * progress modal. Stops at the first failure; clicking again picks up where
 * it left off, since finished images are no longer outdated.
 */
async function rerenderOutdatedImages(bucketId: string) {
  const bucketKey = bucketAesKeys.get(bucketId);
  const bucket = allBucketsCache.find((b) => b.id === bucketId);
  if (!bucketKey || !bucket) {
    showMessage("app-message", "This bucket's key isn't unlocked in this session — log out and back in with your passkey.", "error");
    return;
  }

  let outdated: any[];
  try {
    const imagesResult = await apiFetch("/admin/images?device_key=" + encodeURIComponent(bucketId));
    outdated = imagesResult.images.filter(isOutdatedImage);
  } catch (err: any) {
    showMessage("app-message", "Failed to load this bucket's image list: " + err.message, "error");
    return;
  }
  if (outdated.length === 0) {
    await refreshBucket(bucketId);
    return;
  }

  const withoutCrop = outdated.filter((img) => BOARD_IDS.some((board) => !img.variants?.[board]?.cropped_bytes)).length;
  const proceed = confirm(
    "Re-render " + outdated.length + (outdated.length === 1 ? " photo" : " photos") + " with the latest image processing? " +
      "Each one is downloaded, processed in this browser and re-uploaded, so a large bucket takes a while." +
      (withoutCrop > 0
        ? "\n\n" + withoutCrop + " of them were uploaded before crops were saved, so they'll be re-cropped centered with no zoom. " +
          "Re-upload those instead if you want to keep a custom crop."
        : "")
  );
  if (!proceed) return;

  const total = outdated.length;
  progressModalOpen("Re-rendering photos", "re-rendered", 0, total);
  for (let i = 0; i < total; i++) {
    const img = outdated[i];
    progressModalUpdate(i, total, "Re-rendering " + img.filename + "…");
    try {
      await withRateLimitRetry(
        () => rerenderOneImage(img.id, bucketKey, bucket.key_version ?? 1),
        (seconds) => progressModalUpdate(i, total, "Server busy — continuing with " + img.filename + " in " + seconds + "s…")
      );
    } catch (err: any) {
      progressModalUpdate(i, total, "Failed on " + img.filename + ": " + err.message);
      showMessage(
        "app-message",
        "Re-render stopped: " + img.filename + " failed (" + err.message + "). Click Re-render again to continue with the rest.",
        "error"
      );
      await refreshBucket(bucketId);
      return;
    }
    // Its thumbnail changed (possibly its shape too) - drop the cached
    // decrypted copy so refreshBucket() decrypts the new one.
    const staleThumbUrl = thumbnailUrlCache[img.id];
    if (staleThumbUrl) {
      URL.revokeObjectURL(staleThumbUrl);
      delete thumbnailUrlCache[img.id];
    }
  }
  progressModalUpdate(total, total, "Done.");
  await refreshBucket(bucketId);
}
(window as any).rerenderOutdatedImages = rerenderOutdatedImages;

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
      await withRateLimitRetry(
        () => reencryptOneImage(bucketId, rotationId, imageId, oldBucketKey, newKey),
        (seconds) => rotateModalUpdate(migrated, total, "Server busy — continuing with " + meta.filename + " in " + seconds + "s…")
      );
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
          "<td>" + (r.ota_error
            ? "OTA to <code>" + escapeHtml(r.ota_target_version || "?") + "</code> failed: " + escapeHtml(r.ota_error)
            : escapeHtml(r.reset_reason) + (r.crash_task ? " (" + escapeHtml(r.crash_task) + ")" : "")) + "</td>" +
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

// ---- Alerts (webhooks) — see routes/admin/notifications.ts ----

/** Best guess at the payload format from a pasted URL; the user can still
 *  override it in the select. */
function guessWebhookFormat(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (host === "hooks.slack.com") return "slack";
  if ((host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) && url.pathname.startsWith("/api/webhooks/")) return "discord";
  if (host === "ntfy.sh" || host.startsWith("ntfy.")) return "ntfy";
  return "json";
}

el("new-webhook-url").addEventListener("input", () => {
  const guess = guessWebhookFormat(el<HTMLInputElement>("new-webhook-url").value);
  if (guess) el<HTMLSelectElement>("new-webhook-format").value = guess;
});

const WEBHOOK_FORMAT_LABELS: Record<string, string> = { json: "JSON", slack: "Slack", discord: "Discord", ntfy: "ntfy" };

function renderWebhooksTable(webhooks: any[]) {
  const tbody = el("webhooks-table");
  if (webhooks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No webhooks yet &mdash; add one below to get alerts.</td></tr>';
    return;
  }
  tbody.innerHTML = webhooks.map((w) => {
    const delivery = !w.last_attempt_at
      ? '<span class="hint">never sent</span>'
      : w.last_error
      ? '<span class="pill red" title="' + escapeHtml(w.last_error) + '">failed</span> <span class="hint">' + formatRelativeTime(w.last_attempt_at) + "</span>"
      : '<span class="pill green">ok</span> <span class="hint">' + formatRelativeTime(w.last_attempt_at) + "</span>";
    return "<tr>" +
      "<td>" + escapeHtml(w.label || "") + "</td>" +
      "<td>" + escapeHtml(WEBHOOK_FORMAT_LABELS[w.format] || w.format) + "</td>" +
      "<td><code>" + escapeHtml(w.url_preview) + "</code></td>" +
      "<td>" + delivery + "</td>" +
      '<td><button class="ghost sm" onclick="testWebhook(' + jsArg(w.id) + ')">Send test</button> ' +
      '<button class="danger sm" onclick="deleteWebhook(' + jsArg(w.id) + ')">Remove</button></td>' +
      "</tr>";
  }).join("");
}

function renderAlertDevicesList(devices: any[]) {
  const list = el("alert-devices-list");
  if (devices.length === 0) {
    list.innerHTML = '<p class="hint">No devices registered yet.</p>';
    return;
  }
  list.innerHTML = devices.map((d) => {
    const id = "alert-mute-" + encodeURIComponent(d.mac);
    return '<div class="row checkbox-row">' +
      '<input type="checkbox" id="' + id + '"' + (d.alerts_muted ? "" : " checked") +
      ' onchange="setDeviceAlertsMuted(' + jsArg(d.mac) + ', !this.checked)">' +
      '<label for="' + id + '" style="margin:0;">' + escapeHtml(d.label || d.mac) + "</label>" +
      "</div>";
  }).join("");
}

async function loadWebhooks() {
  const result = await apiFetch("/admin/notifications/webhooks");
  renderWebhooksTable(result.webhooks);
}

el("add-webhook-btn").addEventListener("click", async () => {
  const url = el<HTMLInputElement>("new-webhook-url").value.trim();
  const format = el<HTMLSelectElement>("new-webhook-format").value;
  const label = el<HTMLInputElement>("new-webhook-label").value.trim();
  if (!url.startsWith("https://")) {
    showMessage("app-message", "Webhook URL must start with https://", "error");
    return;
  }
  try {
    const created = await apiFetch("/admin/notifications/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, format, label: label || undefined }),
    });
    el<HTMLInputElement>("new-webhook-url").value = "";
    el<HTMLInputElement>("new-webhook-label").value = "";
    // Only the json format carries a signature; the secret is never shown again.
    el("webhook-secret").innerHTML = format === "json"
      ? '<div class="message success">Webhook added. Signing secret (shown once &mdash; save it if your receiver verifies <code>X-Eink-Signature</code>): <code style="word-break:break-all;">' +
        escapeHtml(created.signing_secret) + "</code></div>"
      : "";
    await loadWebhooks();
  } catch (err: any) {
    showMessage("app-message", "Failed to add webhook: " + err.message, "error");
  }
});

async function testWebhook(id: string) {
  try {
    await apiFetch("/admin/notifications/webhooks/" + encodeURIComponent(id) + "/test", { method: "POST" });
    showMessage("app-message", "Test alert sent.", "success");
  } catch (err: any) {
    showMessage("app-message", "Test alert failed: " + err.message, "error");
  }
  await loadWebhooks().catch(() => {});
}
(window as any).testWebhook = testWebhook;

async function deleteWebhook(id: string) {
  if (!confirm("Remove this webhook? It will stop receiving alerts.")) return;
  try {
    await apiFetch("/admin/notifications/webhooks/" + encodeURIComponent(id), { method: "DELETE" });
    await loadWebhooks();
  } catch (err: any) {
    showMessage("app-message", "Failed to remove webhook: " + err.message, "error");
  }
}
(window as any).deleteWebhook = deleteWebhook;

// ---- Email alerts — see routes/admin/notifications.ts, lib/email-alerts.ts ----

function renderEmailsTable(available: boolean, emails: any[]) {
  // The add form only makes sense when the server can actually send; existing
  // rows (e.g. from before email was switched off) stay visible and removable.
  el("add-email-form").style.display = available ? "" : "none";
  const tbody = el("emails-table");
  if (emails.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">' +
      (available ? "No email addresses yet &mdash; add one below." : "Email alerts aren't configured on this server.") +
      "</td></tr>";
    return;
  }
  tbody.innerHTML = emails.map((e) => {
    const status = e.verified_at
      ? '<span class="pill green">confirmed</span>'
      : '<span class="pill yellow" title="Confirmation sent ' + escapeHtml(new Date(e.verify_sent_at * 1000).toLocaleString()) + '">check inbox</span>';
    const delivery = !e.last_attempt_at
      ? '<span class="hint">never sent</span>'
      : e.last_error
      ? '<span class="pill red" title="' + escapeHtml(e.last_error) + '">failed</span> <span class="hint">' + formatRelativeTime(e.last_attempt_at) + "</span>"
      : '<span class="pill green">ok</span> <span class="hint">' + formatRelativeTime(e.last_attempt_at) + "</span>";
    const action = e.verified_at
      ? '<button class="ghost sm" onclick="testEmail(' + jsArg(e.id) + ')">Send test</button> '
      : '<button class="ghost sm" onclick="resendEmail(' + jsArg(e.id) + ')">Resend</button> ';
    return "<tr>" +
      "<td>" + escapeHtml(e.email) + "</td>" +
      "<td>" + status + "</td>" +
      "<td>" + delivery + "</td>" +
      "<td>" + action + '<button class="danger sm" onclick="deleteEmail(' + jsArg(e.id) + ')">Remove</button></td>' +
      "</tr>";
  }).join("");
}

async function loadEmails() {
  const result = await apiFetch("/admin/notifications/emails");
  renderEmailsTable(result.available, result.emails);
}

el("add-email-btn").addEventListener("click", async () => {
  const email = el<HTMLInputElement>("new-email-address").value.trim();
  if (!email.includes("@")) {
    showMessage("app-message", "Enter an email address.", "error");
    return;
  }
  try {
    await apiFetch("/admin/notifications/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    el<HTMLInputElement>("new-email-address").value = "";
    showMessage("app-message", "Confirmation email sent to " + email + ". Click the link in it to start getting alerts.", "success");
    await loadEmails();
  } catch (err: any) {
    showMessage("app-message", "Failed to add email: " + err.message, "error");
  }
});

async function resendEmail(id: string) {
  try {
    await apiFetch("/admin/notifications/emails/" + encodeURIComponent(id) + "/resend", { method: "POST" });
    showMessage("app-message", "Confirmation email sent again.", "success");
  } catch (err: any) {
    showMessage("app-message", "Couldn't resend: " + err.message, "error");
  }
  await loadEmails().catch(() => {});
}
(window as any).resendEmail = resendEmail;

async function testEmail(id: string) {
  try {
    await apiFetch("/admin/notifications/emails/" + encodeURIComponent(id) + "/test", { method: "POST" });
    showMessage("app-message", "Test alert email sent.", "success");
  } catch (err: any) {
    showMessage("app-message", "Test email failed: " + err.message, "error");
  }
  await loadEmails().catch(() => {});
}
(window as any).testEmail = testEmail;

async function deleteEmail(id: string) {
  if (!confirm("Remove this email address? It will stop receiving alerts.")) return;
  try {
    await apiFetch("/admin/notifications/emails/" + encodeURIComponent(id), { method: "DELETE" });
    await loadEmails();
  } catch (err: any) {
    showMessage("app-message", "Failed to remove email: " + err.message, "error");
  }
}
(window as any).deleteEmail = deleteEmail;

async function setDeviceAlertsMuted(mac: string, muted: boolean) {
  try {
    await apiFetch("/admin/devices/" + encodeURIComponent(mac), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alerts_muted: muted }),
    });
    const cached = devicesCache.find((d: any) => d.mac === mac);
    if (cached) cached.alerts_muted = muted;
  } catch (err: any) {
    showMessage("app-message", "Failed to update alerts for " + mac + ": " + err.message, "error");
    renderAlertDevicesList(devicesCache);
  }
}
(window as any).setDeviceAlertsMuted = setDeviceAlertsMuted;

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
  renderAlertDevicesList(devices);
  loadWebhooks().catch((err) => showMessage("app-message", "Failed to load webhooks: " + err.message, "error"));
  loadEmails().catch((err) => showMessage("app-message", "Failed to load email alerts: " + err.message, "error"));
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
  }
  renderLockedBanner();
  renderRecoveryNudge();

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
