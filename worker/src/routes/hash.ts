import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { resolveDeviceKey } from "../lib/auth-device";
import { verifyDeviceSignature } from "../lib/device-signature";
import { getRotationSnapshot, peekPendingImage } from "../lib/rotation";
import { renderRegistrationBuffer } from "../lib/qr-registration";
import { registrationUrl } from "../lib/registration-url";

/**
 * GET /hash — contract-critical (firmware/src/main.cpp checkImageChanged()).
 * MUST be plain text, exactly 16 chars on success, and MUST NOT advance rotation —
 * only /image_packed's markServed() does that. Any non-200 makes firmware fail-open
 * (treats it as "changed"), so a 404 here is safe when there's nothing to serve.
 */
export function registerHashRoute(app: Hono<{ Bindings: Env }>) {
  app.get("/hash", async (c) => {
    const macHeader = c.req.header("X-Device-MAC");
    let deviceKey: string = DEFAULT_DEVICE_KEY;
    let mac: string | null = null;
    if (macHeader) {
      mac = normalizeMac(macHeader);
      const lookup = await resolveDeviceKey(c.env, mac);
      deviceKey = lookup.deviceKey;

      if (deviceKey !== DEFAULT_DEVICE_KEY) {
        const valid = await verifyDeviceSignature(
          c.env,
          mac,
          lookup.secret!,
          "/hash",
          c.req.header("X-Device-Timestamp"),
          c.req.header("X-Device-Signature")
        );
        if (!valid) return c.text("Invalid or missing device signature", 401);
      }
    }

    // A real (but unregistered) MAC gets a "scan to register" QR instead of the
    // shared default rotation — see plan §QR registration.
    if (mac && deviceKey === DEFAULT_DEVICE_KEY) {
      const { hash } = await renderRegistrationBuffer(
        mac,
        registrationUrl(c.req.url, mac, c.req.header("X-Device-Secret"))
      );
      return c.text(hash, 200, { "Content-Type": "text/plain" });
    }

    const snapshot = await getRotationSnapshot(c.env, deviceKey);
    const pending = peekPendingImage(snapshot);
    if (!pending) return c.text("No image", 404);

    return c.text(pending.image.packedHash, 200, { "Content-Type": "text/plain" });
  });
}
