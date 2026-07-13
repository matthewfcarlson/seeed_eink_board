import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { resolveDeviceKey } from "../lib/auth-device";
import { verifyDeviceSignature } from "../lib/device-signature";

const MAX_BACKTRACE_ENTRIES = 16;
const MAX_REPORTS_PER_DEVICE = 20;

interface CrashReportBody {
  firmware_version?: string;
  rolled_back?: boolean;
  reset_reason?: string;
  boot_attempts?: number;
  crash_task?: string;
  crash_pc?: string;
  crash_cause?: number;
  backtrace?: string[];
  backtrace_corrupted?: boolean;
}

/**
 * POST /crash_report — device_config's sibling for OTA safety (firmware/src/
 * ota_health.cpp + main.cpp's sendCrashReportIfPending()). Fired at most once
 * per boot, only after the firmware has already proven connectivity works, so
 * this never blocks or gates anything on the device side — it just records
 * what OtaHealth found: a boot-time panic/watchdog reset, and/or an OTA that
 * got rolled back (bootloader-automatic or app-forced after too many
 * unconfirmed boots). See CLAUDE.md's OTA section.
 *
 * Same auth gate as /device_config: an unclaimed device (DEFAULT_DEVICE_KEY)
 * still gets a 200 — so its firmware clears the queued report and stops
 * retrying — but nothing is persisted, since there's no user to attribute an
 * unclaimed device's report to.
 */
export function registerCrashReportRoute(app: Hono<{ Bindings: Env }>) {
  app.post("/crash_report", async (c) => {
    const macHeader = c.req.header("X-Device-MAC");
    if (!macHeader) return c.text("X-Device-MAC header is required", 400);
    const mac = normalizeMac(macHeader);

    const lookup = await resolveDeviceKey(c.env, mac);
    if (lookup.deviceKey !== DEFAULT_DEVICE_KEY) {
      const valid = await verifyDeviceSignature(
        c.env,
        mac,
        lookup.secret!,
        "/crash_report",
        c.req.header("X-Device-Nonce"),
        c.req.header("X-Device-Signature")
      );
      if (!valid) return c.text("Invalid or missing device signature", 401);
    }

    const body = await c.req.json<CrashReportBody>().catch(() => null);
    if (!body || !body.firmware_version || !body.reset_reason) {
      return c.text("firmware_version and reset_reason are required", 400);
    }

    if (lookup.deviceKey === DEFAULT_DEVICE_KEY) {
      return c.json({ stored: false });
    }

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const backtrace = Array.isArray(body.backtrace) ? body.backtrace.slice(0, MAX_BACKTRACE_ENTRIES) : null;

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO crash_reports
           (id, device_mac, firmware_version, rolled_back, reset_reason, boot_attempts,
            crash_task, crash_pc, crash_cause, backtrace, backtrace_corrupted, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        mac,
        body.firmware_version,
        body.rolled_back ? 1 : 0,
        body.reset_reason,
        body.boot_attempts ?? 0,
        body.crash_task ?? null,
        body.crash_pc ?? null,
        body.crash_cause ?? null,
        backtrace ? JSON.stringify(backtrace) : null,
        typeof body.backtrace_corrupted === "boolean" ? (body.backtrace_corrupted ? 1 : 0) : null,
        now
      ),
      // Bound growth: keep only the most recent MAX_REPORTS_PER_DEVICE rows per device.
      c.env.DB.prepare(
        `DELETE FROM crash_reports WHERE device_mac = ? AND id NOT IN (
           SELECT id FROM crash_reports WHERE device_mac = ? ORDER BY received_at DESC LIMIT ?
         )`
      ).bind(mac, mac, MAX_REPORTS_PER_DEVICE),
    ]);

    return c.json({ stored: true, id }, 201);
  });
}
