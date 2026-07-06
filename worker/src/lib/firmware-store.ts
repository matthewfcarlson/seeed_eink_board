import type { Env } from "../types";
import { kvKeys } from "./kv-keys";

/**
 * Firmware binaries are stored byte-exact (no gzip, unlike packed images in
 * image-store.ts) — the ESP32 Update library flashes them straight to the OTA
 * partition, and adding gunzip to the firmware just to save KV space isn't worth it.
 */
export async function putFirmwareBinary(env: Env, version: string, bytes: Uint8Array): Promise<void> {
  await env.KV.put(kvKeys.firmwareBin(version), bytes);
}

export async function getFirmwareBinary(env: Env, version: string): Promise<ArrayBuffer | null> {
  return env.KV.get(kvKeys.firmwareBin(version), "arrayBuffer");
}

/** Full 64-hex-char digest — unlike dither.ts's computeHash16, the firmware needs
 *  the whole SHA-256 to verify the OTA download before it commits to booting it. */
export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
