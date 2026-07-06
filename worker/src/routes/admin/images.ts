import type { Hono } from "hono";
import {
  DEFAULT_DEVICE_KEY,
  DITHER_ALGORITHMS,
  PACKED_BYTES,
  type DitherAlgorithm,
  type Env,
} from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { invalidateRotationCache } from "../../lib/rotation";
import { decodeToLandscapeBuffer, isHeic, isSupportedImageType } from "../../lib/decode";
import { computeHash16, ditherImage, enhance, packToNibbles } from "../../lib/dither";
import { deleteImageBlobs, getThumbnailDataUrl, putPackedImage, putRawImage, putThumbnail } from "../../lib/image-store";
import { makeThumbnailJpeg } from "../../lib/thumbnail";

const DEFAULT_BRIGHTNESS = 1.0;
const DEFAULT_CONTRAST = 1.2;
const DEFAULT_SATURATION = 1.2;

/** Registered devices are owned per-user; the shared 'default' bucket (matching
 *  image_server.py's single shared images/default/ folder) is writable by any
 *  authenticated user — there's no per-user isolation for it today, same as Python. */
async function assertDeviceKeyOwnership(env: Env, deviceKey: string, userId: string): Promise<boolean> {
  if (deviceKey === DEFAULT_DEVICE_KEY) return true;
  const row = await env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
    .bind(deviceKey)
    .first<{ user_id: string | null }>();
  return row?.user_id === userId;
}

function isValidDitherAlgorithm(value: string): value is DitherAlgorithm {
  return (DITHER_ALGORITHMS as string[]).includes(value);
}

/**
 * Ingestion runs entirely in the Worker (decode -> EXIF-correct -> resize/crop ->
 * rotate -> enhance -> dither -> pack -> hash -> store), per the user's explicit
 * requirement that this not be a local CLI. HEIC/HEIF is intentionally rejected —
 * no reliable JS/WASM decoder exists for it and it's just an intermediate format.
 */
export function registerAdminImageRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/images/upload", requireAdmin, async (c) => {
    const deviceKey = c.req.query("device_key");
    const filename = c.req.query("filename");
    const ditherParam = c.req.query("dither") ?? "floyd_steinberg";

    if (!deviceKey || !filename) {
      return c.json({ error: "device_key and filename query params are required" }, 400);
    }
    if (!isValidDitherAlgorithm(ditherParam)) {
      return c.json({ error: `dither must be one of: ${DITHER_ALGORITHMS.join(", ")}` }, 400);
    }
    if (!(await assertDeviceKeyOwnership(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const contentType = c.req.header("Content-Type");
    if (isHeic(contentType ?? null, filename)) {
      return c.json(
        { error: "HEIC/HEIF is not supported — convert to JPEG first (e.g. iOS share sheet 'Most Compatible', or `sips -s format jpeg`)." },
        415
      );
    }
    if (!isSupportedImageType(contentType ?? null)) {
      return c.json({ error: "Unsupported Content-Type. Use image/jpeg, image/png, image/webp, image/gif, or image/bmp." }, 415);
    }

    const rawBytes = new Uint8Array(await c.req.arrayBuffer());
    if (rawBytes.byteLength === 0) return c.json({ error: "Empty request body" }, 400);

    let landscape;
    try {
      landscape = await decodeToLandscapeBuffer(rawBytes);
    } catch (err) {
      return c.json({ error: `Failed to decode image: ${(err as Error).message}` }, 422);
    }

    // Generated from the pre-enhance, pre-dither portrait crop so the dashboard
    // preview shows true color and the exact framing the firmware will display —
    // this is also the easiest way to see how a non-native aspect ratio got cropped.
    const thumbnail = makeThumbnailJpeg(landscape.portrait.rgba, landscape.portrait.width, landscape.portrait.height);

    enhance(landscape.rgba, landscape.width, landscape.height, DEFAULT_BRIGHTNESS, DEFAULT_CONTRAST, DEFAULT_SATURATION);
    const indices = ditherImage(landscape.rgba, landscape.width, landscape.height, ditherParam);
    const packed = packToNibbles(indices);

    if (packed.byteLength !== PACKED_BYTES) {
      return c.json({ error: `Internal error: packed output was ${packed.byteLength} bytes, expected ${PACKED_BYTES}` }, 500);
    }

    const packedHash = await computeHash16(packed);

    // Reuse the existing row's id (if any) so KV blob keys stay stable on re-upload —
    // otherwise ON CONFLICT would silently leave the old id's blobs orphaned in KV.
    const existing = await c.env.DB.prepare("SELECT id FROM images WHERE device_key = ? AND filename = ?")
      .bind(deviceKey, filename)
      .first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();

    await Promise.all([
      putPackedImage(c.env, deviceKey, id, packed),
      putRawImage(c.env, deviceKey, id, rawBytes),
      putThumbnail(c.env, deviceKey, id, thumbnail),
    ]);

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO images (id, device_key, filename, dither_algorithm, packed_hash, packed_bytes, raw_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_key, filename) DO UPDATE SET
         dither_algorithm = excluded.dither_algorithm,
         packed_hash = excluded.packed_hash,
         packed_bytes = excluded.packed_bytes,
         raw_bytes = excluded.raw_bytes,
         created_at = excluded.created_at`
    )
      .bind(id, deviceKey, filename, ditherParam, packedHash, packed.byteLength, rawBytes.byteLength, now)
      .run();

    await invalidateRotationCache(c.env, deviceKey);

    return c.json(
      { id, device_key: deviceKey, filename, dither_algorithm: ditherParam, packed_hash: packedHash, packed_bytes: packed.byteLength },
      201
    );
  });

  app.get("/admin/images", requireAdmin, async (c) => {
    const deviceKey = c.req.query("device_key");
    if (!deviceKey) return c.json({ error: "device_key query param is required" }, 400);
    if (!(await assertDeviceKeyOwnership(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const rows = await c.env.DB.prepare(
      "SELECT id, filename, dither_algorithm, packed_hash, packed_bytes, raw_bytes, created_at FROM images WHERE device_key = ? ORDER BY filename ASC"
    )
      .bind(deviceKey)
      .all<{ id: string; filename: string; dither_algorithm: string; packed_hash: string; packed_bytes: number; raw_bytes: number; created_at: number }>();

    const images = await Promise.all(
      rows.results.map(async (row) => ({
        ...row,
        thumbnail_data_url: await getThumbnailDataUrl(c.env, deviceKey, row.id),
      }))
    );
    return c.json({ images });
  });

  app.delete("/admin/images/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const row = await c.env.DB.prepare("SELECT device_key FROM images WHERE id = ?")
      .bind(id)
      .first<{ device_key: string }>();

    if (!row) return c.json({ error: "Not found" }, 404);
    if (!(await assertDeviceKeyOwnership(c.env, row.device_key, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await c.env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id).run();
    await deleteImageBlobs(c.env, row.device_key, id);
    await invalidateRotationCache(c.env, row.device_key);

    return c.json({ deleted: id });
  });
}
