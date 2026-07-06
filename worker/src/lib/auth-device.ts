import type { DeviceLookup, Env } from "../types";
import { DEFAULT_DEVICE_KEY } from "../types";
import { kvKeys } from "./kv-keys";

const DEVICE_CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h; correctness-critical changes invalidate explicitly

/**
 * Resolve a normalized MAC to the device_key its requests should be served under.
 * Unregistered MACs fall back to the shared 'default' bucket (matches image_server.py's
 * directory-fallback behavior) rather than being rejected — see plan §Auth.
 *
 * A row with no secret is treated the same as no row at all: deviceKey stays
 * 'default'. That's what forces devices claimed before the secret column existed
 * (or any row an admin created without one) back through the QR registration flow
 * — see plan §device auth. Once deviceKey resolves to an actual mac, callers MUST
 * still verify a signature (lib/device-signature.ts) before trusting it; this
 * function alone does not authenticate the request.
 */
export async function resolveDeviceKey(env: Env, mac: string): Promise<DeviceLookup> {
  const cacheKey = kvKeys.device(mac);
  const cached = await env.KV.get<DeviceLookup>(cacheKey, "json");
  if (cached) return cached;

  const row = await env.DB.prepare("SELECT mac, user_id, secret FROM devices WHERE mac = ?")
    .bind(mac)
    .first<{ mac: string; user_id: string | null; secret: string | null }>();

  const lookup: DeviceLookup =
    row && row.secret
      ? { deviceKey: row.mac, userId: row.user_id, secret: row.secret }
      : { deviceKey: DEFAULT_DEVICE_KEY, userId: null, secret: null };

  await env.KV.put(cacheKey, JSON.stringify(lookup), { expirationTtl: DEVICE_CACHE_TTL_SECONDS });
  return lookup;
}

/** Call after any admin mutation to a device row so the next request re-resolves from D1. */
export async function invalidateDeviceCache(env: Env, mac: string): Promise<void> {
  await env.KV.delete(kvKeys.device(mac));
}

export async function recordDeviceSeen(
  env: Env,
  mac: string,
  ip: string | null,
  batteryVoltage: number | null
): Promise<void> {
  if (mac === DEFAULT_DEVICE_KEY) return; // matches Python: record_device_request no-ops for 'default'
  const now = Math.floor(Date.now() / 1000);
  if (batteryVoltage !== null) {
    await env.DB.prepare(
      `UPDATE devices SET last_seen_at = ?, last_seen_ip = ?, last_battery_voltage = ?, last_battery_at = ? WHERE mac = ?`
    )
      .bind(now, ip, batteryVoltage, now, mac)
      .run();
  } else {
    await env.DB.prepare(`UPDATE devices SET last_seen_at = ?, last_seen_ip = ? WHERE mac = ?`)
      .bind(now, ip, mac)
      .run();
  }
}
