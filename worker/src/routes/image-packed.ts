import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { resolveDeviceKey } from "../lib/auth-device";
import { verifyDeviceSignature } from "../lib/device-signature";
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
    // A device identifies itself via X-Device-MAC on every request; with no
    // header there is nothing to authenticate and nothing to serve. Bucket
    // content must never be reachable without it — see migrations/0009_bucket_ownership.sql.
    if (!macHeader) return c.text("X-Device-MAC header required", 400);

    const mac = normalizeMac(macHeader);
    const lookup = await resolveDeviceKey(c.env, mac);
    const deviceKey = lookup.deviceKey;

    // A registered device's mac isn't enough on its own — see lib/device-signature.ts.
    // Without this, anyone who knows/guesses a registered mac could impersonate that
    // device just by sending X-Device-MAC.
    if (deviceKey !== DEFAULT_DEVICE_KEY) {
      const valid = await verifyDeviceSignature(
        c.env,
        mac,
        lookup.secret!,
        "/image_packed",
        c.req.header("X-Device-Nonce"),
        c.req.header("X-Device-Signature")
      );
      if (!valid) return c.text("Invalid or missing device signature", 401);
    }

    // A real but unregistered MAC gets a "scan to register" QR instead of any
    // bucket's rotation — see plan §QR registration. Never touches rotation
    // state, since it isn't part of any device's image rotation.
    if (deviceKey === DEFAULT_DEVICE_KEY) {
      const { packed, hash } = await renderRegistrationBuffer(
        mac,
        registrationUrl(c.req.url, mac, c.req.header("X-Device-Secret"))
      );
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
