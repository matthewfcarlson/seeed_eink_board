import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";

const DEFAULT_LIMIT = 50;

/**
 * Recent crash/rollback reports across every device the caller owns — see
 * routes/crash-report.ts for how these get written. Read-only: there's
 * nothing to edit here, only to review; old rows age out via that route's
 * per-device cap on insert.
 */
export function registerAdminCrashReportRoutes(app: Hono<{ Bindings: Env }>) {
  app.get("/admin/crash-reports", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT cr.id, cr.device_mac, cr.firmware_version, cr.rolled_back, cr.reset_reason,
              cr.boot_attempts, cr.crash_task, cr.crash_pc, cr.crash_cause, cr.backtrace,
              cr.backtrace_corrupted, cr.received_at
       FROM crash_reports cr
       JOIN devices d ON d.mac = cr.device_mac
       WHERE d.user_id = ?
       ORDER BY cr.received_at DESC
       LIMIT ?`
    )
      .bind(c.var.user.id, DEFAULT_LIMIT)
      .all();
    return c.json({ reports: rows.results });
  });
}
