import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { resolveDeviceKey } from "../lib/auth-device";
import { getRotationSnapshot, markServed, peekPendingImage } from "../lib/rotation";
import { getPackedImage } from "../lib/image-store";
import { renderRegistrationBuffer } from "../lib/qr-registration";
import { registrationUrl } from "../lib/registration-url";

/**
 * GET /image_packed — contract-critical (firmware/src/main.cpp fetchAndDisplayImage()).
 * Content-Length must exactly match the body; X-Image-Hash must be the same 16-char
 * hash /hash would have returned for this same pending image. Rotation only advances
 * after we've successfully read the object from R2 — never on a failed/missing fetch.
 */
export function registerImagePackedRoute(app: Hono<{ Bindings: Env }>) {
  app.get("/image_packed", async (c) => {
    const macHeader = c.req.header("X-Device-MAC");
    let deviceKey: string = DEFAULT_DEVICE_KEY;
    let mac: string | null = null;
    if (macHeader) {
      mac = normalizeMac(macHeader);
      deviceKey = (await resolveDeviceKey(c.env, mac)).deviceKey;
    }

    // A real (but unregistered) MAC gets a "scan to register" QR instead of the
    // shared default rotation — see plan §QR registration. Never touches
    // rotation state, since it isn't part of any device's image rotation.
    if (mac && deviceKey === DEFAULT_DEVICE_KEY) {
      const { packed, hash } = await renderRegistrationBuffer(mac, registrationUrl(c.req.url, mac));
      return new Response(packed, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(packed.byteLength),
          "Content-Disposition": "attachment; filename=image.bin",
          "X-Image-Hash": hash,
          "X-Image-Name": "register-device",
          "X-Device-ID": deviceKey,
        },
      });
    }

    const snapshot = await getRotationSnapshot(c.env, deviceKey);
    const pending = peekPendingImage(snapshot);
    if (!pending) return c.text("No images available", 404);

    const bytes = await getPackedImage(c.env, pending.image.sourceDeviceKey, pending.image.id);
    if (!bytes) return c.text("Failed to process image", 500);

    const writeback = await markServed(c.env, deviceKey, snapshot, pending.index, pending.image.id);
    c.executionCtx.waitUntil(writeback());

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "attachment; filename=image.bin",
        "X-Image-Hash": pending.image.packedHash,
        "X-Image-Name": pending.image.filename,
        "X-Device-ID": deviceKey,
      },
    });
  });
}
