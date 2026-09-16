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
 * HKDF `info` context strings provide domain separation between the two
 * things this module derives keys for — a shared ECDH secret must never be
 * reinterpretable as a key for the other purpose.
 */

export const HKDF_INFO_BUCKET_WRAP = "eink-bucket-wrap-v1";
export const HKDF_INFO_SHARING_KEY_WRAP = "eink-sharing-key-wrap-v1";

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

/** Derives the KEK that protects a user's sharing private key from one
 *  WebAuthn ceremony's PRF extension output (see admin.ts's login/register).
 *  PRF output is scoped to the *credential*, not the account — the caller is
 *  responsible for wrapping/unwrapping per-credential, not per-user. */
export async function deriveKekFromPrf(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  return hkdfDeriveAesKey(prfOutput, HKDF_INFO_SHARING_KEY_WRAP);
}
