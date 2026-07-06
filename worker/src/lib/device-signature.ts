import type { Env } from "../types";

const ENCODER = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare — signatures are equal-length hex strings, but don't
 *  short-circuit on the first mismatching byte (timing side channel). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secretHex: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Verifies a device's HMAC-signed request and enforces a monotonic timestamp to
 * block replay — see plan §device auth. `path` disambiguates endpoints so a
 * captured /hash signature can't be replayed against /image_packed.
 *
 * The timestamp check is deliberately "never goes backwards" rather than "within
 * N seconds of wall-clock now": the ESP32's clock isn't NTP-synced, only
 * monotonic (RTC keeps ticking across deep sleep), so a freshness window would
 * either reject legitimate devices with drifted clocks or have to be so wide it
 * stops blocking anything.
 *
 * On success this also advances last_signature_timestamp in D1 so the same
 * signature can never be replayed again once time moves forward — caller should
 * NOT await this if it isn't already on the response's critical path, though in
 * practice this is cheap enough to just await directly.
 */
export async function verifyDeviceSignature(
  env: Env,
  mac: string,
  secret: string,
  path: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined
): Promise<boolean> {
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;

  const expected = await hmacHex(secret, `${mac}|${path}|${timestamp}`);
  if (!timingSafeEqual(expected, signatureHeader.toLowerCase())) return false;

  const row = await env.DB.prepare("SELECT last_signature_timestamp FROM devices WHERE mac = ?")
    .bind(mac)
    .first<{ last_signature_timestamp: number }>();
  if (row && timestamp < row.last_signature_timestamp) return false;

  await env.DB.prepare(
    "UPDATE devices SET last_signature_timestamp = ? WHERE mac = ? AND last_signature_timestamp <= ?"
  )
    .bind(timestamp, mac, timestamp)
    .run();

  return true;
}
