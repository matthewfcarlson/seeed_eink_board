import type { Hono } from "hono";
import type { Env } from "../types";
import { getFirmwareBinary } from "../lib/firmware-store";

/**
 * GET /firmware_bin?version=X — contract-critical (firmware/src/main.cpp
 * checkAndApplyFirmwareUpdate()). Streams the raw binary byte-exact (no gzip —
 * the ESP32 Update library flashes these bytes directly) with X-Firmware-SHA256
 * set to the full 64-hex-char digest computed at sync time, which the firmware
 * verifies (via mbedtls sha256) before committing to booting the new image.
 */
export function registerFirmwareBinRoute(app: Hono<{ Bindings: Env }>) {
  app.get("/firmware_bin", async (c) => {
    const version = c.req.query("version");
    if (!version) return c.text("version query param is required", 400);

    const row = await c.env.DB.prepare("SELECT sha256 FROM firmware_releases WHERE version = ?")
      .bind(version)
      .first<{ sha256: string }>();
    if (!row) return c.text("Unknown firmware version", 404);

    const bytes = await getFirmwareBinary(c.env, version);
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
