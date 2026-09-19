import type { Hono } from "hono";
import type { Env } from "../types";
import { getFirmwareBinary } from "../lib/firmware-store";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "../lib/rate-limit";
import { isValidFirmwareVersion } from "../lib/validate";

/**
 * GET /firmware_bin?version=X — contract-critical (firmware/lib/common/device_app.h's
 * performFirmwareOTA()). Streams the raw binary byte-exact (no gzip —
 * the ESP32 Update library flashes these bytes directly) with X-Firmware-SHA256
 * set to the full 64-hex-char digest computed at sync time, which the firmware
 * verifies (via mbedtls sha256) before committing to booting the new image.
 *
 * firmware_releases is keyed by (board, version) — the same version tag is
 * deliberately reused across boards (one shared FIRMWARE_VERSION), so this
 * must be scoped by the caller's own board, not version alone, or two boards'
 * binaries collide in both D1 and KV. Read from X-Device-Board, the same
 * header addCommonHeaders() already sends on every device-facing request
 * (including this one) — see device_app.h.
 */
export function registerFirmwareBinRoute(app: Hono<{ Bindings: Env }>) {
  app.get("/firmware_bin", async (c) => {
    // No MAC on this endpoint (board comes from X-Device-Board) — rate limit
    // per client IP. The binaries are public GitHub release assets anyway;
    // the limit just stops bulk scraping through our KV.
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    if (!(await checkRateLimit(c.env, "firmware", ip, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowSeconds))) {
      return rateLimitedResponse(RATE_LIMITS.device.windowSeconds);
    }
    const version = c.req.query("version");
    if (!version) return c.text("version query param is required", 400);
    // Echoed back as the X-Firmware-Version response header below — bound the
    // charset so a malformed query can't wedge the header write.
    if (!isValidFirmwareVersion(version)) return c.text("Invalid firmware version", 400);
    const board = c.req.header("X-Device-Board");
    if (!board) return c.text("X-Device-Board header is required", 400);

    const row = await c.env.DB.prepare("SELECT sha256 FROM firmware_releases WHERE board = ? AND version = ?")
      .bind(board, version)
      .first<{ sha256: string }>();
    if (!row) return c.text("Unknown firmware version", 404);

    const bytes = await getFirmwareBinary(c.env, board, version);
    if (!bytes) return c.text("Firmware binary missing from storage", 500);

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "attachment; filename=firmware.bin",
        "X-Firmware-SHA256": row.sha256,
        "X-Firmware-Version": version,
      },
    });
  });
}
