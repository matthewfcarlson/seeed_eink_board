import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET, type Env, type ScheduleConfig } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { invalidateScheduleCache } from "../../lib/schedule";

/** Same range validation as image_server.py's parse_schedule_form(). */
function validateScheduleBody(body: unknown): { config: ScheduleConfig } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Invalid body" };
  const b = body as Record<string, unknown>;

  const refresh = b.refresh_interval_minutes;
  const start = b.active_start_hour;
  const end = b.active_end_hour;
  const tz = b.timezone_offset_minutes;

  if (typeof refresh !== "number" || refresh < 1 || refresh > 1440) {
    return { error: "Refresh interval must be between 1 and 1440 minutes." };
  }
  if (typeof start !== "number" || start < 0 || start > 23) {
    return { error: "Active start hour must be between 0 and 23." };
  }
  if (typeof end !== "number" || end < 0 || end > 23) {
    return { error: "Active end hour must be between 0 and 23." };
  }
  if (typeof tz !== "number" || tz < -720 || tz > 840) {
    return { error: "Timezone offset must be between -720 and 840 minutes." };
  }

  return {
    config: {
      refresh_interval_minutes: refresh,
      active_start_hour: start,
      active_end_hour: end,
      timezone_offset_minutes: tz,
    },
  };
}

/** Registered devices' overrides are owned per-user; 'default'/'global' are shared,
 *  editable by any authenticated user — matches Python having no per-user isolation. */
async function assertTargetOwnership(env: Env, target: string, userId: string): Promise<boolean> {
  if (target === DEFAULT_DEVICE_KEY || target === GLOBAL_SCHEDULE_TARGET) return true;
  const row = await env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
    .bind(target)
    .first<{ user_id: string | null }>();
  return row?.user_id === userId;
}

export function registerAdminScheduleRoutes(app: Hono<{ Bindings: Env }>) {
  // Exact override row for `target` (or null) — lets the admin UI show current
  // settings before editing, distinct from the device-facing resolved/fallback view.
  app.get("/admin/schedule/:target", requireAdmin, async (c) => {
    const target = c.req.param("target");
    if (!target) return c.json({ error: "target is required" }, 400);
    if (!(await assertTargetOwnership(c.env, target, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const row = await c.env.DB.prepare(
      `SELECT refresh_interval_minutes, active_start_hour, active_end_hour, timezone_offset_minutes, updated_at
       FROM schedule_overrides WHERE target = ?`
    )
      .bind(target)
      .first();

    return c.json({ target, override: row ?? null });
  });

  app.put("/admin/schedule/:target", requireAdmin, async (c) => {
    const target = c.req.param("target");
    if (!target) return c.json({ error: "target is required" }, 400);
    if (!(await assertTargetOwnership(c.env, target, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const result = validateScheduleBody(body);
    if ("error" in result) return c.json({ error: result.error }, 400);

    const { config } = result;
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO schedule_overrides
         (target, refresh_interval_minutes, active_start_hour, active_end_hour, timezone_offset_minutes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET
         refresh_interval_minutes = excluded.refresh_interval_minutes,
         active_start_hour = excluded.active_start_hour,
         active_end_hour = excluded.active_end_hour,
         timezone_offset_minutes = excluded.timezone_offset_minutes,
         updated_at = excluded.updated_at`
    )
      .bind(
        target,
        config.refresh_interval_minutes,
        config.active_start_hour,
        config.active_end_hour,
        config.timezone_offset_minutes,
        now
      )
      .run();

    await invalidateScheduleCache(c.env, target);
    return c.json({ target, config });
  });

  app.delete("/admin/schedule/:target", requireAdmin, async (c) => {
    const target = c.req.param("target");
    if (!target) return c.json({ error: "target is required" }, 400);
    if (!(await assertTargetOwnership(c.env, target, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const result = await c.env.DB.prepare("DELETE FROM schedule_overrides WHERE target = ?")
      .bind(target)
      .run();
    await invalidateScheduleCache(c.env, target);

    return c.json({ cleared: target, existed: (result.meta.changes ?? 0) > 0 });
  });
}
