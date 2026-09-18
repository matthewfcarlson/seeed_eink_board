import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { resolveDeviceKey } from "../lib/auth-device";
import { verifyDeviceSignature } from "../lib/device-signature";
import { isValidMac } from "../lib/validate";

const MAX_BACKTRACE_ENTRIES = 16;
const MAX_REPORTS_PER_DEVICE = 20;
// Every field below is written to D1 and rendered in /admin's Firmware panel.
// The sender is our own firmware, but the endpoint is signature-authed per
// request, not tamper-proofed beyond that — bound each string so a buggy (or
// hostile, MAC+secret-bearing) sender can't wedge arbitrarily large values
// into the report list.
const MAX_FIRMWARE_VERSION_LEN = 64;
const MAX_RESET_REASON_LEN = 64;
const MAX_CRASH_TASK_LEN = 32;
const MAX_CRASH_PC_LEN = 16;
const MAX_BACKTRACE_ENTRY_LEN = 16; // hex PCs like "0x420182a0"

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.length) return null;
  return value.slice(0, max);
}

function boundedInt(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n < 0 ? 0 : Math.min(n, max);
}

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
    // Same validity gate as the other device-facing routes — see image-packed.ts.
    if (!isValidMac(mac)) return c.text("X-Device-MAC header is not a valid MAC address", 400);

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
    if (!body || typeof body.firmware_version !== "string" || !body.firmware_version ||
        typeof body.reset_reason !== "string" || !body.reset_reason) {
      return c.text("firmware_version and reset_reason are required", 400);
    }

    if (lookup.deviceKey === DEFAULT_DEVICE_KEY) {
      return c.json({ stored: false });
    }

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const backtrace = Array.isArray(body.backtrace)
      ? body.backtrace
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
          .slice(0, MAX_BACKTRACE_ENTRIES)
          .map((entry) => entry.slice(0, MAX_BACKTRACE_ENTRY_LEN))
      : null;
    const bootAttempts = boundedInt(body.boot_attempts, 255);
    const crashCause = boundedInt(body.crash_cause, 2147483647);

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO crash_reports
           (id, device_mac, firmware_version, rolled_back, reset_reason, boot_attempts,
            crash_task, crash_pc, crash_cause, backtrace, backtrace_corrupted, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        mac,
        body.firmware_version.slice(0, MAX_FIRMWARE_VERSION_LEN),
        body.rolled_back ? 1 : 0,
        body.reset_reason.slice(0, MAX_RESET_REASON_LEN),
        bootAttempts ?? 0,
        boundedString(body.crash_task, MAX_CRASH_TASK_LEN),
        boundedString(body.crash_pc, MAX_CRASH_PC_LEN),
        crashCause,
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
