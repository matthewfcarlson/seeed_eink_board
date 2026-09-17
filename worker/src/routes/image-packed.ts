import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { resolveDeviceKey } from "../lib/auth-device";
import { verifyDeviceSignature } from "../lib/device-signature";
import { getRotationSnapshot, markServed, peekPendingImage } from "../lib/rotation";
import { getPackedImage } from "../lib/image-store";
import { renderNoBucketBuffer, renderRegistrationBuffer } from "../lib/qr-registration";
import { assignBucketUrl, registrationUrl } from "../lib/registration-url";

/**
 * GET /image_packed — contract-critical (firmware/src/main.cpp fetchAndDisplayImage()).
 * Content-Length must exactly match the body; X-Image-Hash must be the same 16-char
 * hash /hash would have returned for this same pending image. Rotation only advances
 * after we've successfully read the object from R2 — never on a failed/missing fetch.
 *
 * Optional ?known_hash=<16-char hash> lets current firmware fold the old separate
 * /hash pre-check into this same request/TLS-handshake: if it matches the pending
 * image's hash, respond 304 with no body and don't touch rotation (same "unchanged"
 * contract /hash has). Omitting it (older firmware) behaves exactly as before -
 * always 200 with the full image - so this is purely additive, /hash stays untouched.
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
    // Registered but nothing to show — no bucket assigned, every assigned
    // bucket has zero images, or removed from every bucket it had. Same
    // "never leave the screen on a bare error" reasoning as the
    // unregistered-device QR branch above, just one step later in the
    // device's lifecycle. Unencrypted, like that branch: there may be no
    // bucket (and so no key) to encrypt under here at all.
    if (!pending) {
      const { packed, hash } = await renderNoBucketBuffer(mac, assignBucketUrl(c.req.url, mac));
      return new Response(packed, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(packed.byteLength),
          "Content-Disposition": "attachment; filename=image.bin",
          "X-Image-Hash": hash,
          "X-Image-Name": "no-images-available",
          "X-Device-ID": deviceKey,
        },
      });
    }

    const knownHash = c.req.query("known_hash");
    if (knownHash && knownHash === pending.image.packedHash) {
      return new Response(null, { status: 304, headers: { "X-Image-Hash": pending.image.packedHash } });
    }

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
        // Which of this device's (possibly several) subscribed buckets the
        // ciphertext body is encrypted under — device_app.h looks this up in
        // the bucket_keys it already unwrapped from /device_config to pick
        // the right AES-256-GCM key before decrypting.
        "X-Bucket-Id": pending.image.sourceDeviceKey,
        // Which of that bucket's key versions this specific image is encrypted
        // under (see migrations/0016_bucket_key_rotation.sql) — mid-rotation a
        // device can hold both an old and a new wrapped key for the same
        // bucket_id, so it needs this to pick the right one.
        "X-Bucket-Key-Version": String(pending.image.keyVersion),
        // 'identity' or 'deflate-raw' - see migrations/0017_packed_encoding.sql. Tells
        // device_app.h's fetchAndDisplayImage() whether to stream ciphertext straight
        // into the display buffer (identity) or decrypt+inflate it chunk-by-chunk.
        "X-Packed-Encoding": pending.image.packedEncoding,
      },
    });
  });
}
