import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { recordDeviceSeen, resolveDeviceKey } from "../lib/auth-device";
import { verifyDeviceSignature } from "../lib/device-signature";
import { resolveScheduleConfig } from "../lib/schedule";
import { resolveFirmwareTarget } from "../lib/firmware-target";

/**
 * GET /device_config — contract-critical (firmware/src/main.cpp syncRemoteConfigAndTime()).
 * MUST always include server_time_epoch; schedule fields are omitted (not null) when unset,
 * matching image_server.py's dict.update() semantics — ArduinoJson treats missing keys as
 * "leave current value," so an explicit null would be wrong here.
 *
 * firmware_version/firmware_sha256 are likewise omitted (not null) unless an admin has
 * explicitly targeted a version for this device somewhere in the fallback chain — see
 * lib/firmware-target.ts. No target ever set means "never touch this device's firmware."
 */
export function registerDeviceConfigRoute(app: Hono<{ Bindings: Env }>) {
  app.get("/device_config", async (c) => {
    const macHeader = c.req.header("X-Device-MAC");
    const batteryHeader = c.req.header("X-Battery-Voltage");
    const battery = batteryHeader ? Number.parseFloat(batteryHeader) : NaN;
    const ip = c.req.header("CF-Connecting-IP") ?? null;

    let deviceKey: string = DEFAULT_DEVICE_KEY;
    if (macHeader) {
      const mac = normalizeMac(macHeader);
      const lookup = await resolveDeviceKey(c.env, mac);
      deviceKey = lookup.deviceKey;

      if (deviceKey !== DEFAULT_DEVICE_KEY) {
        const valid = await verifyDeviceSignature(
          c.env,
          mac,
          lookup.secret!,
          "/device_config",
          c.req.header("X-Device-Nonce"),
          c.req.header("X-Device-Signature")
        );
        if (!valid) return c.text("Invalid or missing device signature", 401);
      }

      // Fire-and-forget: last-seen/battery tracking must never delay the response.
      // No-ops for unregistered MACs (no devices row to update) — matches Python's
      // in-memory tracking being effectively per-known-device only in practice.
      c.executionCtx.waitUntil(recordDeviceSeen(c.env, mac, ip, Number.isNaN(battery) ? null : battery));
    }

    const { config, source } = await resolveScheduleConfig(c.env, deviceKey);
    const firmwareVersion = await resolveFirmwareTarget(c.env, deviceKey);

    let firmware: { firmware_version: string; firmware_sha256: string } | Record<string, never> = {};
    if (firmwareVersion) {
      const release = await c.env.DB.prepare("SELECT sha256 FROM firmware_releases WHERE version = ?")
        .bind(firmwareVersion)
        .first<{ sha256: string }>();
      // Guards against a dangling target row pointing at a deleted release.
      if (release) firmware = { firmware_version: firmwareVersion, firmware_sha256: release.sha256 };
    }

    return c.json({
      device_id: deviceKey,
      server_time_epoch: Math.floor(Date.now() / 1000),
      config_source: source,
      ...config,
      ...firmware,
    });
  });
}
