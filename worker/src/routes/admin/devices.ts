import type { Hono } from "hono";
import type { Env } from "../../types";
import { normalizeMac } from "../../lib/mac";
import { invalidateDeviceCache } from "../../lib/auth-device";
import { requireAdmin } from "../../lib/admin-middleware";

export function registerAdminDeviceRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/devices", requireAdmin, async (c) => {
    const body = await c.req.json<{ mac?: string; label?: string }>().catch(() => ({}) as never);
    if (!body.mac) return c.json({ error: "mac is required" }, 400);

    const mac = normalizeMac(body.mac);
    const user = c.var.user;

    const existing = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();
    if (existing && existing.user_id !== user.id) {
      return c.json({ error: "Device already registered to another user" }, 409);
    }

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO devices (mac, user_id, label, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(mac) DO UPDATE SET label = excluded.label`
    )
      .bind(mac, user.id, body.label ?? null, now)
      .run();

    await invalidateDeviceCache(c.env, mac);
    return c.json({ mac, label: body.label ?? null }, 201);
  });

  app.get("/admin/devices", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT mac, label, created_at, last_seen_at, last_seen_ip, last_battery_voltage, last_battery_at FROM devices WHERE user_id = ?"
    )
      .bind(c.var.user.id)
      .all();
    return c.json({ devices: rows.results });
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
