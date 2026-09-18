import type { Hono } from "hono";
import { BOARD_IDS, DEFAULT_BOARD_ID, DITHER_ALGORITHMS, type BoardId, type DitherAlgorithm, type Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { assertBucketAccess, assertBucketReadAccess } from "../../lib/bucket-access";
import { invalidateRotationCache, invalidateRotationCacheForBucketConsumers } from "../../lib/rotation";
import {
  deleteImageBlobs,
  getRawImage,
  getThumbnailCiphertextB64,
  putPackedImage,
  putRawImage,
  putThumbnail,
} from "../../lib/image-store";
import { readCiphertextUploadBytes, validateCiphertextUploadFields } from "../../lib/image-upload";

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
 * receives one raw-original ciphertext blob plus, for every board in
 * BOARD_IDS, that board's packed+thumbnail ciphertext and a client-computed
 * content hash (see lib/image-upload.ts) — a bucket isn't board-scoped, so
 * every upload generates every board's rendition up front rather than
 * waiting to find out which boards actually need one. `dither_algorithm` and
 * each board's `packed_hash` are trusted client-reported metadata (display/
 * change-detection only) — the Worker has no way to verify them without the
 * bucket key, same trust boundary it always implicitly had for upload
 * *content*, now extended to these fields as well.
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
    if (!isValidDitherAlgorithm(ditherParam)) {
      return c.json({ error: `dither_algorithm must be one of: ${DITHER_ALGORITHMS.join(", ")}` }, 400);
    }

    const fields = validateCiphertextUploadFields(body);
    if ("error" in fields) return c.json({ error: fields.error }, 400);
    const bytes = await readCiphertextUploadBytes(fields);
    if ("error" in bytes) return c.json({ error: bytes.error }, 400);
    const { rawBytes, variants } = bytes;

    // A freshly-uploaded image is always encrypted under the bucket's
    // CURRENT key version, whatever that happens to be (1 outside a
    // rotation) — a rotation only ever touches EXISTING images via
    // reencrypt-image, never this route.
    const bucket = await c.env.DB.prepare("SELECT key_version FROM buckets WHERE id = ?")
      .bind(deviceKey)
      .first<{ key_version: number }>();
    const keyVersion = bucket?.key_version ?? 1;

    // Reuse the existing row's id (if any) so KV blob keys stay stable on re-upload —
    // otherwise ON CONFLICT would silently leave the old id's blobs orphaned in KV.
    const existing = await c.env.DB.prepare("SELECT id FROM images WHERE device_key = ? AND filename = ?")
      .bind(deviceKey, filename)
      .first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();

    await Promise.all([
      putRawImage(c.env, deviceKey, id, rawBytes),
      ...BOARD_IDS.flatMap((board) => [
        putPackedImage(c.env, deviceKey, id, board, variants[board].packedBytes),
        putThumbnail(c.env, deviceKey, id, board, variants[board].thumbBytes),
      ]),
    ]);

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO images (id, device_key, filename, dither_algorithm, raw_bytes, created_at, key_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_key, filename) DO UPDATE SET
           dither_algorithm = excluded.dither_algorithm,
           raw_bytes = excluded.raw_bytes,
           created_at = excluded.created_at,
           key_version = excluded.key_version`
      ).bind(id, deviceKey, filename, ditherParam, rawBytes.byteLength, now, keyVersion),
      ...BOARD_IDS.map((board) =>
        c.env.DB.prepare(
          `INSERT INTO image_variants (image_id, board, packed_encoding, packed_hash, packed_bytes)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(image_id, board) DO UPDATE SET
             packed_encoding = excluded.packed_encoding,
             packed_hash = excluded.packed_hash,
             packed_bytes = excluded.packed_bytes`
        ).bind(id, board, fields.variants[board].packedEncoding, fields.variants[board].packedHash, variants[board].packedBytes.byteLength)
      ),
    ]);

    await invalidateRotationCache(c.env, deviceKey);
    await invalidateRotationCacheForBucketConsumers(c.env, deviceKey);

    return c.json(
      {
        id,
        device_key: deviceKey,
        filename,
        dither_algorithm: ditherParam,
        variants: Object.fromEntries(
          BOARD_IDS.map((board) => [
            board,
            {
              packed_hash: fields.variants[board].packedHash,
              packed_bytes: variants[board].packedBytes.byteLength,
              packed_encoding: fields.variants[board].packedEncoding,
            },
          ])
        ),
      },
      201
    );
  });

  app.get("/admin/images", requireAdmin, async (c) => {
    const deviceKey = c.req.query("device_key");
    if (!deviceKey) return c.json({ error: "device_key query param is required" }, 400);
    // Read-shaped: a public bucket's images are viewable by anyone, not just
    // the owner/collaborators — see lib/bucket-access.ts's doc comment.
    if (!(await assertBucketReadAccess(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const rows = await c.env.DB.prepare(
      "SELECT id, filename, dither_algorithm, raw_bytes, created_at, key_version FROM images WHERE device_key = ? ORDER BY filename ASC"
    )
      .bind(deviceKey)
      .all<{
        id: string;
        filename: string;
        dither_algorithm: string;
        raw_bytes: number;
        created_at: number;
        key_version: number;
      }>();

    if (rows.results.length === 0) return c.json({ images: [] });

    const variantRows = await c.env.DB.prepare(
      `SELECT image_id, board, packed_hash, packed_bytes, packed_encoding FROM image_variants
       WHERE image_id IN (${rows.results.map(() => "?").join(",")})`
    )
      .bind(...rows.results.map((r) => r.id))
      .all<{ image_id: string; board: BoardId; packed_hash: string; packed_bytes: number; packed_encoding: string }>();

    const variantsByImage = new Map<string, Record<string, { packed_hash: string; packed_bytes: number; packed_encoding: string }>>();
    for (const v of variantRows.results) {
      const entry = variantsByImage.get(v.image_id) ?? {};
      entry[v.board] = { packed_hash: v.packed_hash, packed_bytes: v.packed_bytes, packed_encoding: v.packed_encoding };
      variantsByImage.set(v.image_id, entry);
    }

    // Ciphertext, base64-encoded — the dashboard decrypts and builds its own
    // data URL client-side with the bucket key it already holds. Preview
    // thumbnail: DEFAULT_BOARD_ID's variant, falling back to whichever board
    // actually has one — this is a human preview, not board-specific.
    const images = await Promise.all(
      rows.results.map(async (row) => {
        const variants = variantsByImage.get(row.id) ?? {};
        const previewBoard = (variants[DEFAULT_BOARD_ID] ? DEFAULT_BOARD_ID : (Object.keys(variants)[0] as BoardId | undefined)) ?? null;
        return {
          ...row,
          variants,
          thumbnail_ciphertext_b64: previewBoard ? await getThumbnailCiphertextB64(c.env, deviceKey, row.id, previewBoard) : null,
        };
      })
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

    // image_variants.image_id references images(id) - must go before the
    // images delete below or D1 rejects it as a FOREIGN KEY constraint
    // failure (see migrations/0019_image_board_variants.sql).
    await c.env.DB.prepare("DELETE FROM image_variants WHERE image_id = ?").bind(id).run();
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
    // Read-shaped: see GET /admin/images above.
    if (!(await assertBucketReadAccess(c.env, deviceKey, c.var.user.id))) {
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
