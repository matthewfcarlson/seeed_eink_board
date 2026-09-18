/**
 * Central input validation for everything a client (browser or firmware) can
 * send us. Kept dependency-free so both Worker routes and unit tests import
 * it directly; limits here are the single source of truth — openapi.yaml and
 * the client-side pre-validation mirror them, not the other way around.
 */

// Human-settable text fields. Generous but bounded — every one of these lands
// in a D1 TEXT column and gets rendered back into HTML (escaped) or into
// response headers (not escaped), so an unbounded value is both a storage and
// a header-injection hazard.
export const MAX_BUCKET_LABEL = 80;
export const MAX_DEVICE_LABEL = 80;
export const MAX_DISPLAY_NAME = 40; // enforced since day one (routes/admin/auth.ts)
export const MAX_FILENAME = 255; // matches common filesystem ceilings; images.filename UNIQUE(device_key, filename)
export const MAX_FIRMWARE_VERSION = 64;

/** Control chars (incl. CR/LF) — filenames end up in the X-Image-Name response
 *  header (routes/image-packed.ts, routes/hash.ts), where a newline would make
 *  the Workers runtime reject the header and break the response entirely. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Standard base64 (with padding), matching client/crypto.ts's toBase64(). */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Returns the trimmed label, or null when it's not a non-empty string within
 * `max` characters. Used for bucket labels and device labels — anything
 * rendered in the admin UI or stored as user-visible text.
 */
export function validateLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Validates an image filename: non-empty string, ≤ MAX_FILENAME, no control
 * characters (they'd break the X-Image-Name response header and D1 doesn't
 * want them either). Does NOT trim — the filename is the (bucket, filename)
 * unique key, and silently altering it would desync client and server views;
 * the client trims before sending.
 */
export function validateFilename(value: unknown): string | null {
  if (typeof value !== "string" || !value.length || value.length > MAX_FILENAME) return null;
  if (CONTROL_CHARS.test(value)) return null;
  return value;
}

/** ESP32 MAC, normalized by lib/mac.ts's normalizeMac(): exactly 12 hex chars. */
export function isValidMac(mac: string): boolean {
  return /^[0-9a-f]{12}$/.test(mac);
}

function isBase64(value: string): boolean {
  return BASE64_PATTERN.test(value) && value.length % 4 === 0;
}

/**
 * Base64 of a raw uncompressed P-256 public point — 65 bytes → exactly 88
 * base64 chars, always ending in a single '=' pad (65 = 3×21 + 2). Same value
 * users.sharing_public_key, devices.sharing_public_key, and the
 * X-Device-Sharing-Public-Key header all carry (see client/crypto.ts's
 * toBase64 + device_app.h's header generation).
 */
export function isValidP256PublicKeyB64(value: unknown): value is string {
  return typeof value === "string" && value.length === 88 && value.endsWith("=") && isBase64(value);
}

/**
 * Base64 of a raw 32-byte AES-256 key (a bucket's content key) — 44 chars
 * ending in a single '=' pad (32 = 3×10 + 2). Only ever appears as
 * buckets.public_key_raw for public buckets (migrations/0018_public_buckets.sql)
 * and rotation finalize bodies.
 */
export function isValidRawAesKeyB64(value: unknown): value is string {
  return typeof value === "string" && value.length === 44 && value.endsWith("=") && isBase64(value);
}

/** Firmware version strings come from git tags with a leading 'v' stripped —
 *  semver-ish tokens. Validated before /firmware_bin echoes one into a
 *  response header (X-Firmware-Version). */
export function isValidFirmwareVersion(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9._+-]{1,${MAX_FIRMWARE_VERSION}}$`).test(value);
}
