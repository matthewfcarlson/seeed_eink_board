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
 * Verifies a device's HMAC-signed request and enforces a monotonic nonce to
 * block replay — see plan §device auth. `path` disambiguates endpoints so a
 * captured /hash signature can't be replayed against /image_packed.
 *
 * The nonce is an opaque counter the firmware persists in NVS (see
 * ConfigManager::nextNonce()), NOT a timestamp. An earlier version used
 * time(nullptr) and required it to "never go backwards," but the ESP32's RTC
 * only survives deep sleep, not a real power loss — a device that ever
 * browned out would send a "time" behind what the server already had on
 * file and get permanently rejected. A flash-backed counter has no such
 * failure mode: it only ever goes up, power loss or not.
 *
 * On success this also advances last_nonce in D1 so the same signature can
 * never be replayed again once the counter moves forward — caller should
 * NOT await this if it isn't already on the response's critical path, though
 * in practice this is cheap enough to just await directly.
 */
export async function verifyDeviceSignature(
  env: Env,
  mac: string,
  secret: string,
  path: string,
  nonceHeader: string | undefined,
  signatureHeader: string | undefined
): Promise<boolean> {
  if (!nonceHeader || !signatureHeader) return false;

  const nonce = Number.parseInt(nonceHeader, 10);
  if (!Number.isFinite(nonce) || nonce <= 0) return false;

  const expected = await hmacHex(secret, `${mac}|${path}|${nonce}`);
  if (!timingSafeEqual(expected, signatureHeader.toLowerCase())) return false;

  const row = await env.DB.prepare("SELECT last_nonce FROM devices WHERE mac = ?")
    .bind(mac)
    .first<{ last_nonce: number }>();
  if (row && nonce < row.last_nonce) return false;

  await env.DB.prepare("UPDATE devices SET last_nonce = ? WHERE mac = ? AND last_nonce <= ?")
    .bind(nonce, mac, nonce)
    .run();

  return true;
}
