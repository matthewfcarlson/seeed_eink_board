import type { Hono } from "hono";
import type { Env } from "../../types";
import { normalizeMac } from "../../lib/mac";
import { invalidateDeviceCache } from "../../lib/auth-device";
import { invalidateRotationCache } from "../../lib/rotation";
import { requireAdmin } from "../../lib/admin-middleware";

// The device's self-generated HMAC key (hex), scanned off its own display via the
// registration QR — see lib/device-signature.ts. Loose length bound since the
// firmware picks the byte count, not this validator; just guards against empty/
// junk values getting stored as a secret.
const SECRET_PATTERN = /^[0-9a-f]{16,64}$/i;

export function registerAdminDeviceRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/devices", requireAdmin, async (c) => {
    const body = await c.req.json<{ mac?: string; label?: string; secret?: string }>().catch(() => ({}) as never);
    if (!body.mac) return c.json({ error: "mac is required" }, 400);
    if (body.secret !== undefined && !SECRET_PATTERN.test(body.secret)) {
      return c.json({ error: "secret must be a hex string" }, 400);
    }

    const mac = normalizeMac(body.mac);
    const user = c.var.user;

    const existing = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();
    if (existing && existing.user_id !== user.id) {
      return c.json({ error: "Device already registered to another user" }, 409);
    }

    const now = Math.floor(Date.now() / 1000);
    // COALESCE keeps any existing secret when the caller doesn't send one (e.g. an
    // admin editing just the label) rather than accidentally locking the device out.
    await c.env.DB.prepare(
      `INSERT INTO devices (mac, user_id, label, secret, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(mac) DO UPDATE SET label = excluded.label, secret = COALESCE(excluded.secret, devices.secret)`
    )
      .bind(mac, user.id, body.label ?? null, body.secret ?? null, now)
      .run();

    await invalidateDeviceCache(c.env, mac);
    return c.json({ mac, label: body.label ?? null }, 201);
  });

  app.get("/admin/devices", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT mac, label, created_at, last_seen_at, last_seen_ip, last_battery_voltage, last_battery_at, include_default_images FROM devices WHERE user_id = ?"
    )
      .bind(c.var.user.id)
      .all<Record<string, unknown> & { include_default_images: number }>();
    const devices = rows.results.map((row) => ({
      ...row,
      include_default_images: row.include_default_images === 1,
    }));
    return c.json({ devices });
  });

  app.patch("/admin/devices/:mac", requireAdmin, async (c) => {
    const macParam = c.req.param("mac");
    if (!macParam) return c.json({ error: "mac is required" }, 400);
    const mac = normalizeMac(macParam);
    const body = await c.req
      .json<{ label?: string; include_default_images?: boolean }>()
      .catch(() => ({}) as never);

    const row = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.user_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    if (body.label !== undefined) {
      await c.env.DB.prepare("UPDATE devices SET label = ? WHERE mac = ?").bind(body.label, mac).run();
    }
    if (body.include_default_images !== undefined) {
      await c.env.DB.prepare("UPDATE devices SET include_default_images = ? WHERE mac = ?")
        .bind(body.include_default_images ? 1 : 0, mac)
        .run();
      await invalidateRotationCache(c.env, mac);
    }

    return c.json({ mac, label: body.label, include_default_images: body.include_default_images });
  });

  app.delete("/admin/devices/:mac", requireAdmin, async (c) => {
    const macParam = c.req.param("mac");
    if (!macParam) return c.json({ error: "mac is required" }, 400);
    const mac = normalizeMac(macParam);
    const row = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();

    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.user_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare("DELETE FROM devices WHERE mac = ?").bind(mac).run();
    await invalidateDeviceCache(c.env, mac);
    return c.json({ deleted: mac });
  });
}
