import type { Hono } from "hono";
import { DITHER_ALGORITHMS, type DitherAlgorithm, type Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { assertBucketAccess } from "../../lib/bucket-access";
import { invalidateRotationCache, invalidateRotationCacheForBucketConsumers } from "../../lib/rotation";
import {
  deleteImageBlobs,
  getRawImage,
  getThumbnailCiphertextB64,
  putPackedImage,
  putRawImage,
  putThumbnail,
} from "../../lib/image-store";

function isValidDitherAlgorithm(value: string): value is DitherAlgorithm {
  return (DITHER_ALGORITHMS as string[]).includes(value);
}

/** Shared by the delete and raw-image routes. */
async function findImageDeviceKey(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT device_key FROM images WHERE id = ?")
    .bind(id)
    .first<{ device_key: string }>();
  return row?.device_key ?? null;
}

/**
 * Ingestion (decode -> EXIF-correct -> resize/crop -> rotate -> enhance ->
 * dither -> pack -> hash -> encrypt) runs entirely client-side now — see root
 * CLAUDE.md's encrypted-buckets plan. This route never sees plaintext: it
 * receives three already-encrypted blobs (raw original, packed 4bpp, thumbnail)
 * plus a client-computed content hash, and its only job is validate-and-store,
 * gated by the same assertBucketAccess check as before. `dither_algorithm` and
 * `packed_hash` are trusted client-reported metadata (display/change-detection
 * only) — the Worker has no way to verify them without the bucket key, same
 * trust boundary it always implicitly had for upload *content*, now extended
 * to these two fields as well.
 */
export function registerAdminImageRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/images/upload", requireAdmin, async (c) => {
    const deviceKey = c.req.query("device_key");
    const filename = c.req.query("filename");

    if (!deviceKey || !filename) {
      return c.json({ error: "device_key and filename query params are required" }, 400);
    }
    if (!(await assertBucketAccess(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.parseBody();
    const ditherParam = typeof body.dither_algorithm === "string" ? body.dither_algorithm : "floyd_steinberg";
    const packedHash = body.packed_hash;
    const raw = body.raw;
    const packed = body.packed;
    const thumb = body.thumb;

    if (!isValidDitherAlgorithm(ditherParam)) {
      return c.json({ error: `dither_algorithm must be one of: ${DITHER_ALGORITHMS.join(", ")}` }, 400);
    }
    if (typeof packedHash !== "string" || packedHash.length !== 16) {
      return c.json({ error: "packed_hash (16-char hex string) is required" }, 400);
    }
    if (!(raw instanceof File) || !(packed instanceof File) || !(thumb instanceof File)) {
      return c.json({ error: "raw, packed, and thumb ciphertext files are required" }, 400);
    }

    const [rawBytes, packedBytes, thumbBytes] = await Promise.all([
      raw.arrayBuffer().then((b) => new Uint8Array(b)),
      packed.arrayBuffer().then((b) => new Uint8Array(b)),
      thumb.arrayBuffer().then((b) => new Uint8Array(b)),
    ]);
    if (rawBytes.byteLength === 0 || packedBytes.byteLength === 0 || thumbBytes.byteLength === 0) {
      return c.json({ error: "Empty ciphertext body" }, 400);
    }

    // Reuse the existing row's id (if any) so KV blob keys stay stable on re-upload —
    // otherwise ON CONFLICT would silently leave the old id's blobs orphaned in KV.
    const existing = await c.env.DB.prepare("SELECT id FROM images WHERE device_key = ? AND filename = ?")
      .bind(deviceKey, filename)
      .first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();

    await Promise.all([
      putPackedImage(c.env, deviceKey, id, packedBytes),
      putRawImage(c.env, deviceKey, id, rawBytes),
      putThumbnail(c.env, deviceKey, id, thumbBytes),
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
      .bind(id, deviceKey, filename, ditherParam, packedHash, packedBytes.byteLength, rawBytes.byteLength, now)
      .run();

    await invalidateRotationCache(c.env, deviceKey);
    await invalidateRotationCacheForBucketConsumers(c.env, deviceKey);

    return c.json(
      { id, device_key: deviceKey, filename, dither_algorithm: ditherParam, packed_hash: packedHash, packed_bytes: packedBytes.byteLength },
      201
    );
  });

  app.get("/admin/images", requireAdmin, async (c) => {
    const deviceKey = c.req.query("device_key");
    if (!deviceKey) return c.json({ error: "device_key query param is required" }, 400);
    if (!(await assertBucketAccess(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const rows = await c.env.DB.prepare(
      "SELECT id, filename, dither_algorithm, packed_hash, packed_bytes, raw_bytes, created_at FROM images WHERE device_key = ? ORDER BY filename ASC"
    )
      .bind(deviceKey)
      .all<{ id: string; filename: string; dither_algorithm: string; packed_hash: string; packed_bytes: number; raw_bytes: number; created_at: number }>();

    // Ciphertext, base64-encoded — the dashboard decrypts and builds its own
    // data URL client-side with the bucket key it already holds.
    const images = await Promise.all(
      rows.results.map(async (row) => ({
        ...row,
        thumbnail_ciphertext_b64: await getThumbnailCiphertextB64(c.env, deviceKey, row.id),
      }))
    );
    return c.json({ images });
  });

  app.delete("/admin/images/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const deviceKey = await findImageDeviceKey(c.env, id);
    if (!deviceKey) return c.json({ error: "Not found" }, 404);
    if (!(await assertBucketAccess(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await c.env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id).run();
    await deleteImageBlobs(c.env, deviceKey, id);
    await invalidateRotationCache(c.env, deviceKey);
    await invalidateRotationCacheForBucketConsumers(c.env, deviceKey);

    return c.json({ deleted: id });
  });

  // Serves the original as-uploaded ciphertext for the dashboard's
  // hover-to-enlarge preview — the browser decrypts it, not the Worker. Not
  // cacheable by device_key/filename like the catalog list — callers only
  // know the image id — so ownership is re-checked per request same as delete.
  app.get("/admin/images/:id/raw", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const deviceKey = await findImageDeviceKey(c.env, id);
    if (!deviceKey) return c.json({ error: "Not found" }, 404);
    if (!(await assertBucketAccess(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const raw = await getRawImage(c.env, deviceKey, id);
    if (!raw) return c.json({ error: "Not found" }, 404);

    // Not long-cacheable: re-uploading the same filename reuses this id (see the
    // upload handler above), so the bytes at this URL can change over time.
    return new Response(new Uint8Array(raw), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-cache",
      },
    });
  });
}
