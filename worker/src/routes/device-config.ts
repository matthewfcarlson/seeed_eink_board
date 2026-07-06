import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { recordDeviceSeen, resolveDeviceKey } from "../lib/auth-device";
import { resolveScheduleConfig } from "../lib/schedule";

/**
 * GET /device_config — contract-critical (firmware/src/main.cpp syncRemoteConfigAndTime()).
 * MUST always include server_time_epoch; schedule fields are omitted (not null) when unset,
 * matching image_server.py's dict.update() semantics — ArduinoJson treats missing keys as
 * "leave current value," so an explicit null would be wrong here.
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
      deviceKey = (await resolveDeviceKey(c.env, mac)).deviceKey;
      // Fire-and-forget: last-seen/battery tracking must never delay the response.
      // No-ops for unregistered MACs (no devices row to update) — matches Python's
      // in-memory tracking being effectively per-known-device only in practice.
      c.executionCtx.waitUntil(recordDeviceSeen(c.env, mac, ip, Number.isNaN(battery) ? null : battery));
    }

    const { config, source } = await resolveScheduleConfig(c.env, deviceKey);

    return c.json({
      device_id: deviceKey,
      server_time_epoch: Math.floor(Date.now() / 1000),
      config_source: source,
      ...config,
    });
  });
}
