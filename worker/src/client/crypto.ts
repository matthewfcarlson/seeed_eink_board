/**
 * Client-side (browser) crypto core for encrypted image buckets — see root
 * CLAUDE.md's plan. Everything here runs in the browser, never in the Worker:
 * the whole point is that the Worker never holds a bucket key, a sharing
 * private key, or plaintext image bytes.
 *
 * Curve choice: P-256, not X25519 — WebCrypto's ECDH support for P-256 is
 * universal across evergreen browsers (Safari included), and mbedtls on the
 * ESP32 firmware side already supports MBEDTLS_ECP_DP_SECP256R1. Neither
 * WebCrypto nor mbedtls has a canned "encrypt to a public key" call, so
 * wrapping here is hand-rolled ECIES: an ephemeral P-256 keypair, ECDH with
 * the recipient's public key, HKDF-SHA256 into an AES-256-GCM key, then
 * AES-GCM-encrypt the payload.
 *
 * HKDF `info` context strings provide domain separation between the things
 * this module derives keys for — a shared ECDH secret (or a bucket key) must
 * never be reinterpretable as a key for another purpose.
 */

export const HKDF_INFO_BUCKET_WRAP = "eink-bucket-wrap-v1";
export const HKDF_INFO_SHARING_KEY_WRAP = "eink-sharing-key-wrap-v1";
export const HKDF_INFO_CONTENT_HASH = "eink-content-hash-v1";
export const HKDF_INFO_RECOVERY_WRAP = "eink-recovery-wrap-v1";

const ECDH_PARAMS: EcKeyImportParams & EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const AES_GCM_KEY_LEN = 256;
const GCM_NONCE_BYTES = 12;

export interface WrappedKey {
  ephemeralPub: string; // base64, raw uncompressed P-256 point (65 bytes)
  nonce: string; // base64, 12 bytes
  ciphertext: string; // base64
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe, unpadded variant — used only for the invite link's `#key=`
 *  fragment (admin.ts), where `+`/`/`/`=` would be an unnecessary copy-paste
 *  footgun even though they're technically legal in a URL fragment. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return fromBase64(withPadding);
}

/** One P-256 keypair for a principal (user or device). Both halves are
 *  extractable — the private key must be exportable so it can be wrapped
 *  (AES-GCM-encrypted) for storage, since WebCrypto has no "encrypt this key
 *  to that other key" primitive of its own. */
export async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

export async function exportPublicKeyRaw(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
}

export async function importPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), ECDH_PARAMS, true, []);
}

export async function exportPrivateKeyPkcs8(privateKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
}

export async function importPrivateKeyPkcs8(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", new Uint8Array(pkcs8), ECDH_PARAMS, true, ["deriveBits"]);
}

/** Raw uncompressed public point (0x04 || x || y) of a P-256 private key,
 *  recomputed from the key itself (its JWK carries x/y) rather than taken on
 *  the server's word — used to confirm a key recovered from a wrap is really
 *  the account's registered identity. */
export async function publicKeyRawFromPrivateKey(privateKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const x = fromBase64Url(jwk.x!);
  const y = fromBase64Url(jwk.y!);
  const raw = new Uint8Array(1 + x.length + y.length);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 1 + x.length);
  return raw;
}

/** HKDF-SHA256(sharedSecret, info) -> AES-256-GCM key. `salt` is deliberately
 *  empty (RFC 5869 treats a missing salt as a fixed-length string of zeros) —
 *  the `info` context string is what provides domain separation here, not the
 *  salt, since every call already has a distinct high-entropy input secret. */
async function hkdfDeriveAesKey(secretBits: ArrayBuffer, info: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", secretBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    baseKey,
    { name: "AES-GCM", length: AES_GCM_KEY_LEN },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Random AES-256-GCM bucket content-encryption key, extractable so it can be
 *  ECIES-wrapped for each authorized principal and held in memory for the session. */
export async function generateBucketKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: AES_GCM_KEY_LEN }, true, ["encrypt", "decrypt"]);
}

export async function exportAesKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/** 16-hex-char keyed content hash over a plaintext packed buffer — the upload
 *  duplicate-detection value (migrations/0020_image_content_hash.sql).
 *
 *  Computed over the PLAINTEXT (packToNibbles output, before compress/encrypt),
 *  so identical renditions of the same photo collide regardless of source-file
 *  format or filename — unlike dither.ts's computeHash16, which hashes
 *  ciphertext whose random GCM nonce makes every upload's hash differ.
 *
 *  Keyed (HKDF from the bucket key, HMAC-SHA256) rather than a plain SHA-256
 *  so the Worker can only ever compare hashes WITHIN one bucket: it can't
 *  correlate identical images across buckets or precompute a lookup table.
 *  Bucket-key rotation recomputes these under the new key (admin.ts's
 *  reencryptOneImage), so hashes stay comparable after a completed rotation.
 *  Like packed_hash, the Worker can't verify it — trusted client metadata,
 *  a courtesy check rather than a security boundary. */
export async function computeContentHash(bucketKey: CryptoKey, packed: Uint8Array): Promise<string> {
  // Rewrap through `new Uint8Array(...)` so the buffer is a plain ArrayBuffer
  // (exportAesKeyRaw's Uint8Array<ArrayBufferLike> doesn't satisfy importKey's
  // BufferSource under strict lib typings — same normalization computeHash16
  // in dither.ts does).
  const baseKey = await crypto.subtle.importKey("raw", new Uint8Array(await exportAesKeyRaw(bucketKey)), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO_CONTENT_HASH) },
    baseKey,
    256
  );
  const hmacKey = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", hmacKey, new Uint8Array(packed));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export async function importAesKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM", length: AES_GCM_KEY_LEN }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypts a blob (image raw/packed/thumb bytes) under a bucket key, with a
 *  fresh random nonce prepended to the ciphertext — same shape KV stores it
 *  in, mirroring the gzip-magic-byte trick image-store.ts used to use. */
export async function aesGcmEncryptBlob(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new Uint8Array(plaintext))
  );
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

export async function aesGcmDecryptBlob(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  const nonce = new Uint8Array(blob.subarray(0, GCM_NONCE_BYTES));
  const ciphertext = new Uint8Array(blob.subarray(GCM_NONCE_BYTES));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return new Uint8Array(plaintext);
}

/** ECIES-wrap a raw key (a bucket's AES key, or a sharing private key) for a
 *  recipient's P-256 public key. `info` must be one of the HKDF_INFO_* constants
 *  above — never reuse one context's derived key material as another's. */
export async function wrapKeyFor(recipientPublicKeyRaw: Uint8Array, rawKeyToWrap: Uint8Array, info: string): Promise<WrappedKey> {
  const ephemeral = await generateP256KeyPair();
  const recipientPub = await importPublicKeyRaw(recipientPublicKeyRaw);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: recipientPub } as EcdhKeyDeriveParams, ephemeral.privateKey, 256);
  const kek = await hkdfDeriveAesKey(sharedBits, info);
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, kek, new Uint8Array(rawKeyToWrap))
  );
  const ephemeralPubRaw = await exportPublicKeyRaw(ephemeral.publicKey);
  return { ephemeralPub: toBase64(ephemeralPubRaw), nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

/** Reverses wrapKeyFor using the recipient's own private key. `info` must match
 *  what was passed to wrapKeyFor exactly, or the AES-GCM tag check fails. */
export async function unwrapKeyWith(recipientPrivateKey: CryptoKey, wrapped: WrappedKey, info: string): Promise<Uint8Array> {
  const ephemeralPub = await importPublicKeyRaw(fromBase64(wrapped.ephemeralPub));
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPub } as EcdhKeyDeriveParams, recipientPrivateKey, 256);
  const kek = await hkdfDeriveAesKey(sharedBits, info);
  const nonce = fromBase64(wrapped.nonce);
  const ciphertext = fromBase64(wrapped.ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce) },
    kek,
    new Uint8Array(ciphertext)
  );
  return new Uint8Array(plaintext);
}

/** Plain AES-GCM encrypt/decrypt with nonce and ciphertext returned/taken as
 *  separate base64 strings, for the two D1 columns that store them separately
 *  (credentials.wrapped_sharing_key/wrap_nonce) — unlike aesGcmEncryptBlob's
 *  combined-blob format used for KV image storage. */
export async function aesGcmEncryptToStrings(key: CryptoKey, plaintext: Uint8Array): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new Uint8Array(plaintext))
  );
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

export async function aesGcmDecryptFromStrings(key: CryptoKey, nonce: string, ciphertext: string): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(fromBase64(nonce)) },
    key,
    new Uint8Array(fromBase64(ciphertext))
  );
  return new Uint8Array(plaintext);
}

/** Derives the KEK that protects a user's sharing private key from one
 *  WebAuthn ceremony's PRF extension output (see admin.ts's login/register).
 *  PRF output is scoped to the *credential*, not the account — the caller is
 *  responsible for wrapping/unwrapping per-credential, not per-user. */
export async function deriveKekFromPrf(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  return hkdfDeriveAesKey(prfOutput, HKDF_INFO_SHARING_KEY_WRAP);
}

// --- Recovery codes (migrations/0025_recovery_code.sql) --------------------
//
// 20 random bytes (160 bits) shown as 32 Crockford base32 characters in
// groups of four behind an "RC1-" version tag. Full-entropy random, so a
// plain HKDF is enough — no password-hashing work factor to tune, and
// nothing to brute-force even with the ciphertext in hand.

const RECOVERY_CODE_BYTES = 20;
const RECOVERY_CODE_PREFIX = "RC1";
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateRecoveryCodeBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
}

export function formatRecoveryCode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let chars = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff; // never more than 12 live bits
    bits += 8;
    while (bits >= 5) {
      chars += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // 160 bits is an exact multiple of 5, so there's never a partial group left.
  const groups = chars.match(/.{4}/g) ?? [];
  return [RECOVERY_CODE_PREFIX, ...groups].join("-");
}

/** Lenient parse of a pasted/typed code: case, spaces, and dashes don't
 *  matter, the "RC1" tag is optional, and Crockford's look-alikes (O->0,
 *  I/L->1) are folded. Returns null for anything that isn't exactly 160 bits. */
export function parseRecoveryCode(input: string): Uint8Array | null {
  let chars = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const expectedLen = (RECOVERY_CODE_BYTES * 8) / 5;
  if (chars.length === expectedLen + RECOVERY_CODE_PREFIX.length && chars.startsWith(RECOVERY_CODE_PREFIX)) {
    chars = chars.slice(RECOVERY_CODE_PREFIX.length);
  }
  if (chars.length !== expectedLen) return null;
  const out = new Uint8Array(RECOVERY_CODE_BYTES);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of chars) {
    const idx = CROCKFORD_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

/** KEK that wraps the sharing private key for users.recovery_wrapped_sharing_key. */
export async function deriveKekFromRecoveryCode(codeBytes: Uint8Array): Promise<CryptoKey> {
  return hkdfDeriveAesKey(new Uint8Array(codeBytes).buffer, HKDF_INFO_RECOVERY_WRAP);
}
