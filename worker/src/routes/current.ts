import type { Hono } from "hono";
import type { Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { requireAdmin } from "../lib/admin-middleware";
import { getRotationSnapshot, peekPendingImage } from "../lib/rotation";
import { resolveScheduleConfig } from "../lib/schedule";

/** GET /current — human/debug status endpoint, callable with an admin API key.
 *  Never called by firmware; included in the contract suite only for
 *  field-semantics parity, not byte-for-byte JSON shape. Scoped to the caller's
 *  own devices — this used to be unauthenticated and dump every device on the
 *  server (filenames, battery, schedule) to anyone, see migrations/0009_bucket_ownership.sql. */
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
  app.get("/current", requireAdmin, async (c) => {
    const macParam = c.req.header("X-Device-MAC") ?? c.req.query("device");

    if (macParam) {
      const mac = normalizeMac(macParam);
      const device = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
        .bind(mac)
        .first<{ user_id: string | null }>();
      if (!device) return c.json({ error: "Not found" }, 404);
      if (device.user_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);
      return c.json(await buildDeviceStatus(c.env, mac));
    }

    const rows = await c.env.DB.prepare("SELECT mac FROM devices WHERE user_id = ?")
      .bind(c.var.user.id)
      .all<{ mac: string }>();
    const devices: Record<string, Awaited<ReturnType<typeof buildDeviceStatus>>> = {};
    for (const row of rows.results) {
      devices[row.mac] = await buildDeviceStatus(c.env, row.mac);
    }
    return c.json({ devices, total_devices: rows.results.length });
  });
}
