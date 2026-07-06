import type { Hono } from "hono";
import type { Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { resolveDeviceKey } from "../lib/auth-device";
import { getRotationSnapshot, peekPendingImage } from "../lib/rotation";
import { resolveScheduleConfig } from "../lib/schedule";

/** GET /current — human/debug status endpoint. Never called by firmware; included in
 *  the contract suite only for field-semantics parity, not byte-for-byte JSON shape. */
async function buildDeviceStatus(env: Env, deviceKey: string) {
  const snapshot = await getRotationSnapshot(env, deviceKey);
  const pending = peekPendingImage(snapshot);
  const { config, source } = await resolveScheduleConfig(env, deviceKey);
  const deviceRow = await env.DB.prepare(
    "SELECT last_battery_voltage, last_battery_at FROM devices WHERE mac = ?"
  )
    .bind(deviceKey)
    .first<{ last_battery_voltage: number | null; last_battery_at: number | null }>();

  const lastReturnedFilename = snapshot.lastReturned
    ? (snapshot.images.find((img) => img.id === snapshot.lastReturned)?.filename ?? snapshot.lastReturned)
    : null;

  return {
    device_id: deviceKey,
    current_image: lastReturnedFilename,
    pending_image: pending ? pending.image.filename : null,
    total_images: snapshot.images.length,
    schedule_config: config,
    config_source: source,
    battery:
      deviceRow?.last_battery_voltage != null
        ? { voltage: deviceRow.last_battery_voltage, updated_at: deviceRow.last_battery_at }
        : null,
  };
}

export function registerCurrentRoute(app: Hono<{ Bindings: Env }>) {
  app.get("/current", async (c) => {
    const macParam = c.req.header("X-Device-MAC") ?? c.req.query("device");

    if (macParam) {
      const deviceKey = (await resolveDeviceKey(c.env, normalizeMac(macParam))).deviceKey;
      return c.json(await buildDeviceStatus(c.env, deviceKey));
    }

    const rows = await c.env.DB.prepare("SELECT device_key FROM rotation_state").all<{
      device_key: string;
    }>();
    const devices: Record<string, Awaited<ReturnType<typeof buildDeviceStatus>>> = {};
    for (const row of rows.results) {
      devices[row.device_key] = await buildDeviceStatus(c.env, row.device_key);
    }
    return c.json({ devices, total_devices: rows.results.length });
  });
}
