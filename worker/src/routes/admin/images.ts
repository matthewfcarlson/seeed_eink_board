import type { Hono } from "hono";
import { BOARD_IDS, DEFAULT_BOARD_ID, DITHER_ALGORITHMS, isValidBoardId, type BoardId, type DitherAlgorithm, type Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { assertBucketAccess, assertBucketReadAccess } from "../../lib/bucket-access";
import { invalidateRotationCache, invalidateRotationCacheForBucketConsumers } from "../../lib/rotation";
import {
  deleteImageBlobs,
  getCroppedSource,
  getRawImage,
  getThumbnailCiphertextB64,
  putImageVariantBlobs,
  putRawImage,
  upsertImageVariantStatements,
} from "../../lib/image-store";
import {
  readCiphertextUploadBytes,
  readCiphertextVariantBytes,
  validateCiphertextUploadFields,
  validateCiphertextVariantFields,
} from "../../lib/image-upload";
import { validateFilename } from "../../lib/validate";

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
 *
 * Duplicate detection (migrations/0020_image_content_hash.sql): an optional
 * `content_hash` form field — a bucket-key-keyed HMAC over the default
 * board's plaintext packed buffer, computed client-side before encryption —
 * is compared against the bucket's other images, and a match is rejected 409
 * with the existing filename (the client offers "upload anyway" and retries
 * with ?allow_duplicate=1). Re-uploading the SAME filename, hash or not, is
 * the existing overwrite/replace path — never a duplicate.
 */
export function registerAdminImageRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/images/upload", requireAdmin, async (c) => {
    const deviceKey = c.req.query("device_key");
    const filename = c.req.query("filename");

    if (!deviceKey || !filename) {
      return c.json({ error: "device_key and filename query params are required" }, 400);
    }
    // The filename is both half of the UNIQUE(device_key, filename) catalog key and
    // the X-Image-Name response header /image_packed and /hash send back — a control
    // character (or CR/LF) in it would make the Workers runtime reject that header
    // and break every device fetch of this image, so it's rejected at the door.
    if (!validateFilename(filename)) {
      return c.json({ error: "filename must be 1-255 characters with no control characters" }, 400);
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

    // Duplicate check before reading/storing any bytes — the multipart body has
    // already been transferred at this point, but nothing has been written, so a
    // rejected upload leaves zero partial state behind.
    if (fields.contentHash && c.req.query("allow_duplicate") !== "1") {
      const dup = await c.env.DB.prepare(
        "SELECT filename FROM images WHERE device_key = ? AND content_hash = ? AND filename <> ?"
      )
        .bind(deviceKey, fields.contentHash, filename)
        .first<{ filename: string }>();
      if (dup) {
        return c.json(
          {
            error: `duplicate: this bucket already has this rendition as "${dup.filename}" (pass allow_duplicate=1 to upload anyway)`,
            duplicate_of: dup.filename,
          },
          409
        );
      }
    }

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

    await Promise.all([putRawImage(c.env, deviceKey, id, rawBytes), putImageVariantBlobs(c.env, deviceKey, id, bytes)]);

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO images (id, device_key, filename, dither_algorithm, raw_bytes, created_at, key_version, content_hash, pipeline_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_key, filename) DO UPDATE SET
           dither_algorithm = excluded.dither_algorithm,
           raw_bytes = excluded.raw_bytes,
           created_at = excluded.created_at,
           key_version = excluded.key_version,
           content_hash = excluded.content_hash,
           pipeline_version = excluded.pipeline_version`
      ).bind(id, deviceKey, filename, ditherParam, rawBytes.byteLength, now, keyVersion, fields.contentHash ?? null, fields.pipelineVersion),
      ...upsertImageVariantStatements(c.env, id, fields, bytes),
    ]);

    await invalidateRotationCache(c.env, deviceKey);
    await invalidateRotationCacheForBucketConsumers(c.env, deviceKey);

    return c.json(
      {
        id,
        device_key: deviceKey,
        filename,
        dither_algorithm: ditherParam,
        pipeline_version: fields.pipelineVersion,
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

  // Replaces one image's per-board variants (packed/thumb/cropped) with a
  // fresh client-side render under the bucket's CURRENT key — the gallery's
  // "Re-render older photos" button, for images whose pipeline_version is
  // behind (migrations/0029_image_pipeline_version.sql). The raw original is
  // never touched, so it isn't sent. Same multipart shape as upload minus
  // `raw`, plus a required `key_version`: the version of the key the client
  // encrypted with. Anything other than the bucket's current version, which
  // this image must also already be on, is refused with 409 — as is any
  // re-render while a key rotation is in progress, since the rotation owns
  // every image's blobs until it finalizes.
  app.post("/admin/images/:id/rerender", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const image = await c.env.DB.prepare("SELECT device_key, key_version FROM images WHERE id = ?")
      .bind(id)
      .first<{ device_key: string; key_version: number }>();
    if (!image) return c.json({ error: "Not found" }, 404);
    const deviceKey = image.device_key;
    // Write-shaped, same as upload/delete.
    if (!(await assertBucketAccess(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.parseBody();
    const keyVersionField = body.key_version;
    const keyVersion = typeof keyVersionField === "string" && /^\d{1,9}$/.test(keyVersionField) ? Number(keyVersionField) : NaN;
    if (!Number.isInteger(keyVersion)) return c.json({ error: "key_version (integer) is required" }, 400);

    const fields = validateCiphertextVariantFields(body);
    if ("error" in fields) return c.json({ error: fields.error }, 400);

    const [bucket, rotation] = await Promise.all([
      c.env.DB.prepare("SELECT key_version FROM buckets WHERE id = ?").bind(deviceKey).first<{ key_version: number }>(),
      c.env.DB.prepare("SELECT id FROM bucket_rotations WHERE bucket_id = ? AND status = 'in_progress'").bind(deviceKey).first(),
    ]);
    if (rotation) {
      return c.json({ error: "this bucket's key rotation is in progress; finish it before re-rendering" }, 409);
    }
    const currentKeyVersion = bucket?.key_version ?? 1;
    if (keyVersion !== currentKeyVersion || image.key_version !== currentKeyVersion) {
      return c.json({ error: "stale bucket key: reload the page and try again" }, 409);
    }

    const bytes = await readCiphertextVariantBytes(fields);
    if ("error" in bytes) return c.json({ error: bytes.error }, 400);

    await putImageVariantBlobs(c.env, deviceKey, id, bytes);
    await c.env.DB.batch([
      // COALESCE: a client that didn't send a content hash leaves the old one.
      c.env.DB.prepare("UPDATE images SET pipeline_version = ?, content_hash = COALESCE(?, content_hash) WHERE id = ?")
        .bind(fields.pipelineVersion, fields.contentHash ?? null, id),
      ...upsertImageVariantStatements(c.env, id, fields, bytes),
    ]);

    // New packed hashes under the same image id - same reasoning as
    // reencrypt-image's invalidation.
    await invalidateRotationCache(c.env, deviceKey);
    await invalidateRotationCacheForBucketConsumers(c.env, deviceKey);

    return c.json({ id, pipeline_version: fields.pipelineVersion });
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
      "SELECT id, filename, dither_algorithm, raw_bytes, created_at, key_version, pipeline_version FROM images WHERE device_key = ? ORDER BY filename ASC"
    )
      .bind(deviceKey)
      .all<{
        id: string;
        filename: string;
        dither_algorithm: string;
        raw_bytes: number;
        created_at: number;
        key_version: number;
        pipeline_version: number;
      }>();

    if (rows.results.length === 0) return c.json({ images: [] });

    const variantRows = await c.env.DB.prepare(
      `SELECT image_id, board, packed_hash, packed_bytes, packed_encoding, cropped_bytes FROM image_variants
       WHERE image_id IN (${rows.results.map(() => "?").join(",")})`
    )
      .bind(...rows.results.map((r) => r.id))
      .all<{
        image_id: string;
        board: BoardId;
        packed_hash: string;
        packed_bytes: number;
        packed_encoding: string;
        cropped_bytes: number | null;
      }>();

    type VariantSummary = { packed_hash: string; packed_bytes: number; packed_encoding: string; cropped_bytes: number | null };
    const variantsByImage = new Map<string, Record<string, VariantSummary>>();
    for (const v of variantRows.results) {
      const entry = variantsByImage.get(v.image_id) ?? {};
      entry[v.board] = {
        packed_hash: v.packed_hash,
        packed_bytes: v.packed_bytes,
        packed_encoding: v.packed_encoding,
        cropped_bytes: v.cropped_bytes,
      };
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

  // One board's undithered upright crop (migrations/0028_image_cropped_source.sql),
  // as ciphertext. 404 when this image has none (it predates the column, or
  // was uploaded by an older client) - callers fall back to re-cropping the
  // raw original. Same access/caching rules as /raw above.
  app.get("/admin/images/:id/cropped/:board", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const board = c.req.param("board");
    if (!id || !board) return c.json({ error: "id and board are required" }, 400);
    if (!isValidBoardId(board)) return c.json({ error: `board must be one of: ${BOARD_IDS.join(", ")}` }, 400);

    const deviceKey = await findImageDeviceKey(c.env, id);
    if (!deviceKey) return c.json({ error: "Not found" }, 404);
    if (!(await assertBucketReadAccess(c.env, deviceKey, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const cropped = await getCroppedSource(c.env, deviceKey, id, board);
    if (!cropped) return c.json({ error: "Not found" }, 404);

    return new Response(new Uint8Array(cropped), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-cache",
      },
    });
  });
}
