import type { Hono } from "hono";
import { BOARD_IDS, type Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { deleteImageBlobs, putPackedImage, putRawImage, putThumbnail } from "../../lib/image-store";
import { invalidateRotationCache, invalidateRotationCacheForBucketConsumers } from "../../lib/rotation";
import {
  bucketKeyUpsertStatement,
  computeAuthorizedPrincipals,
  deleteBucketKey,
  getBucketKey,
  parseWrappedBucketKey,
  upsertBucketKey,
  type PrincipalRef,
  type WrappedBucketKey,
} from "../../lib/bucket-keys";
import { readCiphertextUploadBytes, validateCiphertextUploadFields } from "../../lib/image-upload";
import {
  MAX_BUCKET_LABEL,
  isValidRawAesKeyB64,
  validateLabel,
} from "../../lib/validate";

/**
 * Builds the admin join-bucket URL using the incoming request's own origin —
 * mirrors lib/registration-url.ts's approach for device claim links. Only the
 * `token` query param, used for the ordinary authorization check below —
 * deliberately NOT the raw bucket key. The client (admin.ts) appends that
 * itself as a `#key=` URL fragment before showing/copying the link, since a
 * fragment is never sent to the server (not in this request, not in Referer
 * headers, not in server logs) — see root CLAUDE.md's encrypted-buckets plan.
 */
function bucketJoinUrl(requestUrl: string, token: string): string {
  const origin = new URL(requestUrl).origin;
  const url = new URL(`${origin}/admin`);
  url.searchParams.set("join_bucket", token);
  return url.toString();
}

function generateInviteToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function registerAdminBucketRoutes(app: Hono<{ Bindings: Env }>) {
  // The bucket's AES-256-GCM content key is generated client-side and never
  // uploaded raw — the caller must already have wrapped it for their own
  // sharing_public_key (see client/crypto.ts's wrapKeyFor and root CLAUDE.md's
  // encrypted-buckets plan) before calling this, same as any other owner
  // access to their own bucket's key.
  //
  // `is_public`/`public_key_raw`: see migrations/0018_public_buckets.sql.
  // Creating a bucket already public at birth is allowed (not just toggling
  // one public later via PATCH) — only a superuser may set is_public true;
  // anyone else gets 403 rather than the flag silently being dropped.
  app.post("/admin/buckets", requireAdmin, async (c) => {
    const body = await c.req
      .json<{ label?: string; key?: unknown; is_public?: boolean; public_key_raw?: string }>()
      .catch(() => ({}) as never);
    const label = validateLabel(body.label, MAX_BUCKET_LABEL);
    if (!label) return c.json({ error: `label is required and must be 1-${MAX_BUCKET_LABEL} characters` }, 400);
    const key = parseWrappedBucketKey(body.key);
    if (!key) return c.json({ error: "key (wrapped bucket key for the caller) is required" }, 400);

    let isPublic = false;
    let publicKeyRaw: string | null = null;
    if (body.is_public) {
      if (!c.var.user.is_superuser) return c.json({ error: "Forbidden: only a superuser may create a public bucket" }, 403);
      if (!isValidRawAesKeyB64(body.public_key_raw)) {
        return c.json({ error: "public_key_raw must be base64 of the bucket's raw 32-byte AES-256 key (44 chars)" }, 400);
      }
      isPublic = true;
      publicKeyRaw = body.public_key_raw;
    }

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    // Atomic: a bucket row that ever committed without its owner's key row
    // would be permanently unwritable and unrecoverable (the Worker never
    // sees the raw key to re-wrap later) — see bucketKeyUpsertStatement's
    // comment. Two sequential `.run()` calls here previously left exactly
    // that gap open to any interruption between them.
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO buckets (id, owner_id, label, created_at, is_public, public_key_raw) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, c.var.user.id, label, now, isPublic ? 1 : 0, publicKeyRaw),
      bucketKeyUpsertStatement(c.env, id, "user", c.var.user.id, key, 1),
    ]);

    return c.json({ id, label, owner_id: c.var.user.id, is_owner: true, is_public: isPublic }, 201);
  });

  app.get("/admin/buckets", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT id, owner_id, label, created_at, key_version, is_public, public_key_raw FROM buckets
       WHERE owner_id = ?1 OR id IN (SELECT bucket_id FROM bucket_shares WHERE user_id = ?1)
          OR is_public = 1
       ORDER BY created_at ASC`
    )
      .bind(c.var.user.id)
      .all<{
        id: string;
        owner_id: string | null;
        label: string;
        created_at: number;
        key_version: number;
        is_public: number;
        public_key_raw: string | null;
      }>();

    // Each bucket's caller-specific wrapped key AT THE BUCKET'S CURRENT
    // VERSION, so the dashboard can unwrap every bucket it has access to
    // right after loading this list — null only for a bucket whose invite
    // hasn't been fully accepted yet (see /join below, which shouldn't
    // normally happen since join() writes both in the same request), one
    // this principal was dropped from mid-rotation (see rotate/finalize), or
    // a public bucket the caller has no personal wrap for at all (surfaced
    // via `public_key_raw` instead — see migrations/0018_public_buckets.sql).
    // `public_key_raw` itself is only ever surfaced when it's actually
    // needed: a caller with their own wrapped `key` (owner or collaborator,
    // including on a bucket that also happens to be public) never needs the
    // raw-key escape hatch, so it's omitted for them even if the row has one.
    const buckets = await Promise.all(
      rows.results.map(async (row) => {
        const isOwner = row.owner_id === c.var.user.id;
        const key = await getBucketKey(c.env, row.id, "user", c.var.user.id, row.key_version);
        return {
          id: row.id,
          owner_id: row.owner_id,
          label: row.label,
          created_at: row.created_at,
          key_version: row.key_version,
          is_owner: isOwner,
          is_public: row.is_public === 1,
          key,
          public_key_raw: !key && row.is_public === 1 ? row.public_key_raw : null,
        };
      })
    );
    return c.json({ buckets });
  });

  // `label` renames as before. `is_public`/`public_key_raw` let the owner
  // toggle a bucket's public flag after creation (see migrations/
  // 0018_public_buckets.sql) — the owner's browser already holds the
  // bucket's raw key via its own wrapped copy at this point, so turning a
  // bucket public just means also uploading that raw key here. At least one
  // of `label`/`is_public` must be present; either can be sent alone.
  app.patch("/admin/buckets/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const body = await c.req
      .json<{ label?: string; is_public?: boolean; public_key_raw?: string }>()
      .catch(() => ({}) as never);
    const label = body.label === undefined ? undefined : validateLabel(body.label, MAX_BUCKET_LABEL);
    if (body.label !== undefined && !label) {
      return c.json({ error: `label must not be blank and must be at most ${MAX_BUCKET_LABEL} characters` }, 400);
    }
    if (label === undefined && body.is_public === undefined) {
      return c.json({ error: "label or is_public is required" }, 400);
    }

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    if (label !== undefined) {
      await c.env.DB.prepare("UPDATE buckets SET label = ? WHERE id = ?").bind(label, id).run();
    }

    let isPublic: boolean | undefined;
    if (body.is_public !== undefined) {
      if (!c.var.user.is_superuser) return c.json({ error: "Forbidden: only a superuser may make a bucket public" }, 403);
      isPublic = !!body.is_public;
      if (isPublic) {
        if (!isValidRawAesKeyB64(body.public_key_raw)) {
          return c.json({ error: "public_key_raw must be base64 of the bucket's raw 32-byte AES-256 key (44 chars)" }, 400);
        }
        await c.env.DB.prepare("UPDATE buckets SET is_public = 1, public_key_raw = ? WHERE id = ?")
          .bind(body.public_key_raw, id)
          .run();
      } else {
        // Toggling off nulls the raw key back out — it's the whole reason
        // this bucket didn't need a normal per-principal wrap; leaving it
        // populated after is_public flips back to 0 would be a silent leak.
        await c.env.DB.prepare("UPDATE buckets SET is_public = 0, public_key_raw = NULL WHERE id = ?").bind(id).run();
      }
    }

    return c.json({ id, label: label ?? undefined, is_public: isPublic });
  });

  app.delete("/admin/buckets/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await invalidateRotationCacheForBucketConsumers(c.env, id);

    const images = await c.env.DB.prepare("SELECT id FROM images WHERE device_key = ?")
      .bind(id)
      .all<{ id: string }>();
    await Promise.all(images.results.map((row) => deleteImageBlobs(c.env, id, row.id)));

    // Children before parents, in one batch - image_variants.image_id
    // references images(id), and bucket_keys.bucket_id references
    // buckets(id), so D1 rejects any of these run out of order as a
    // FOREIGN KEY constraint failure.
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM image_variants WHERE image_id IN (SELECT id FROM images WHERE device_key = ?)").bind(id),
      c.env.DB.prepare("DELETE FROM images WHERE device_key = ?").bind(id),
      c.env.DB.prepare("DELETE FROM device_buckets WHERE bucket_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM bucket_shares WHERE bucket_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM bucket_invites WHERE bucket_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM bucket_keys WHERE bucket_id = ?").bind(id),
      // bucket_rotations rows outlive a finalized rotation (status flips to
      // 'completed', the row itself is never removed) - a bucket that was
      // ever key-rotated would otherwise trip this same FK failure.
      c.env.DB.prepare("DELETE FROM bucket_rotations WHERE bucket_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM buckets WHERE id = ?").bind(id),
    ]);

    return c.json({ deleted: id });
  });

  app.post("/admin/buckets/:id/invite", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const token = generateInviteToken();
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO bucket_invites (bucket_id, token, created_at) VALUES (?, ?, ?)
       ON CONFLICT(bucket_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`
    )
      .bind(id, token, now)
      .run();

    return c.json({ url: bucketJoinUrl(c.req.url, token) });
  });

  app.delete("/admin/buckets/:id/invite", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare("DELETE FROM bucket_invites WHERE bucket_id = ?").bind(id).run();
    return c.json({ revoked: id });
  });

  // `key`: the joining client's own wrap of the raw bucket key it just read
  // from the invite link's `#key=` fragment (never sent here — this body only
  // carries the re-wrapped, durable copy). Not required when the caller turns
  // out to already be the owner (below) — they already have their own key
  // from bucket creation.
  app.post("/admin/buckets/join", requireAdmin, async (c) => {
    const body = await c.req.json<{ token?: string; key?: unknown }>().catch(() => ({}) as never);
    if (!body.token) return c.json({ error: "token is required" }, 400);

    const invite = await c.env.DB.prepare(
      `SELECT b.id AS bucket_id, b.label AS label, b.owner_id AS owner_id, b.key_version AS key_version
       FROM bucket_invites bi JOIN buckets b ON b.id = bi.bucket_id
       WHERE bi.token = ?`
    )
      .bind(body.token)
      .first<{ bucket_id: string; label: string; owner_id: string | null; key_version: number }>();
    if (!invite) return c.json({ error: "Invalid or revoked invite link" }, 404);
    if (invite.owner_id === c.var.user.id) return c.json({ id: invite.bucket_id, label: invite.label });

    const key = parseWrappedBucketKey(body.key);
    if (!key) return c.json({ error: "key (wrapped bucket key for the caller) is required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    // Wrapped at the bucket's CURRENT version — the invite link's `#key=`
    // fragment carries the raw key at whatever version it is right now (see
    // admin.ts's createBucketInvite/joinBucket), so this always matches.
    await upsertBucketKey(c.env, invite.bucket_id, "user", c.var.user.id, key, invite.key_version);
    await c.env.DB.prepare(
      "INSERT INTO bucket_shares (bucket_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(bucket_id, user_id) DO NOTHING"
    )
      .bind(invite.bucket_id, c.var.user.id, now)
      .run();

    return c.json({ id: invite.bucket_id, label: invite.label });
  });

  app.get("/admin/buckets/:id/collaborators", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    // sharing_public_key: needed client-side to wrap a fresh bucket key for
    // each collaborator during POST rotate/:rotationId/finalize (see
    // admin.ts's rotation flow) — not just for display, unlike display_name.
    const rows = await c.env.DB.prepare(
      `SELECT u.id AS id, u.display_name AS display_name, u.sharing_public_key AS sharing_public_key FROM bucket_shares bs
       JOIN users u ON u.id = bs.user_id WHERE bs.bucket_id = ?`
    )
      .bind(id)
      .all<{ id: string; display_name: string | null; sharing_public_key: string | null }>();

    return c.json({ collaborators: rows.results });
  });

  app.delete("/admin/buckets/:id/collaborators/:userId", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    if (!id || !userId) return c.json({ error: "id and userId are required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare("DELETE FROM bucket_shares WHERE bucket_id = ? AND user_id = ?").bind(id, userId).run();
    // Cosmetic, not a real revocation (see root CLAUDE.md's Non-goals: the
    // removed user already unwrapped and could have cached the raw key) —
    // still worth deleting so a re-invited user gets a clean re-wrap instead
    // of a stale row.
    await deleteBucketKey(c.env, id, "user", userId);
    return c.json({ removed: userId });
  });

  // --- Bucket key rotation --------------------------------------------------
  // Closes the "no crypto-level revocation" gap in root CLAUDE.md's
  // encrypted-buckets plan: deleting a bucket_shares/device_buckets row above
  // only blocks *new* access, since anyone who already unwrapped the bucket's
  // key keeps it. A rotation is: start (mint key_version+1, wrap it for the
  // owner) -> reencrypt-image for every image still on the old version ->
  // finalize (wrap the new version for every CURRENTLY live principal and
  // delete every old-version wrap — that delete is the actual revocation).
  //
  // Owner-only throughout, unlike ordinary image/collaborator management:
  // only the one browser session that generated the new raw key can usefully
  // drive this job (a collaborator has no way to contribute a re-encrypted
  // image without that same raw key), so there's no meaningful shared-access
  // story here the way there is for uploads.

  // Client sends its own wrap of a freshly-generated key at key_version + 1.
  // Returns the bucket's current (pre-rotation) key_version and the full list
  // of image ids that still need re-encrypting.
  app.post("/admin/buckets/:id/rotate/start", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id, key_version FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null; key_version: number }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const existing = await c.env.DB.prepare(
      "SELECT id, new_key_version FROM bucket_rotations WHERE bucket_id = ? AND status = 'in_progress'"
    )
      .bind(id)
      .first<{ id: string; new_key_version: number }>();
    if (existing) {
      return c.json(
        {
          error: "A rotation is already in progress for this bucket — call GET rotate/status to resume it.",
          rotation_id: existing.id,
          new_key_version: existing.new_key_version,
        },
        409
      );
    }

    const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as never);
    const key = parseWrappedBucketKey(body.key);
    if (!key) return c.json({ error: "key (the caller's own wrap of a freshly-generated key at key_version + 1) is required" }, 400);

    const newKeyVersion = bucket.key_version + 1;
    const rotationId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    try {
      await c.env.DB.prepare(
        "INSERT INTO bucket_rotations (id, bucket_id, new_key_version, status, created_at) VALUES (?, ?, ?, 'in_progress', ?)"
      )
        .bind(rotationId, id, newKeyVersion, now)
        .run();
    } catch {
      // Lost a race with another tab's rotate/start for this same bucket —
      // the partial unique index on bucket_rotations(bucket_id) WHERE
      // status = 'in_progress' rejected this insert. Report the same 409
      // shape as the pre-check above rather than a raw D1 error.
      const raced = await c.env.DB.prepare(
        "SELECT id, new_key_version FROM bucket_rotations WHERE bucket_id = ? AND status = 'in_progress'"
      )
        .bind(id)
        .first<{ id: string; new_key_version: number }>();
      return c.json(
        { error: "A rotation is already in progress for this bucket.", rotation_id: raced?.id, new_key_version: raced?.new_key_version },
        409
      );
    }

    // The owner's own wrap of the new key, recorded now (not just held in the
    // browser's memory) so a page reload can recover it via GET rotate/status
    // and resume with the SAME new key rather than losing the job.
    await upsertBucketKey(c.env, id, "user", c.var.user.id, key, newKeyVersion);

    const images = await c.env.DB.prepare("SELECT id FROM images WHERE device_key = ?").bind(id).all<{ id: string }>();

    return c.json({
      rotation_id: rotationId,
      bucket_id: id,
      key_version: bucket.key_version,
      new_key_version: newKeyVersion,
      image_ids: images.results.map((r) => r.id),
    });
  });

  // Which image ids are done vs. pending for the bucket's in-progress
  // rotation (if any), plus the caller's own wrapped new-version key — lets a
  // client that closed its tab mid-rotation resume on page load instead of
  // starting a fresh rotation (which would orphan whatever this one already
  // migrated and mint yet another key version).
  app.get("/admin/buckets/:id/rotate/status", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id, key_version FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null; key_version: number }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const rotation = await c.env.DB.prepare(
      "SELECT id, new_key_version, created_at FROM bucket_rotations WHERE bucket_id = ? AND status = 'in_progress'"
    )
      .bind(id)
      .first<{ id: string; new_key_version: number; created_at: number }>();
    if (!rotation) return c.json({ rotation: null, key_version: bucket.key_version });

    const images = await c.env.DB.prepare("SELECT id, key_version FROM images WHERE device_key = ?")
      .bind(id)
      .all<{ id: string; key_version: number }>();
    const doneImageIds = images.results.filter((r) => r.key_version >= rotation.new_key_version).map((r) => r.id);
    const pendingImageIds = images.results.filter((r) => r.key_version < rotation.new_key_version).map((r) => r.id);

    const yourNewKey = await getBucketKey(c.env, id, "user", c.var.user.id, rotation.new_key_version);

    return c.json({
      rotation: {
        id: rotation.id,
        key_version: bucket.key_version,
        new_key_version: rotation.new_key_version,
        created_at: rotation.created_at,
        pending_image_ids: pendingImageIds,
        done_image_ids: doneImageIds,
        your_new_key: yourNewKey,
      },
    });
  });

  // Client uploads one image's re-encrypted raw/packed/thumb ciphertext,
  // already re-run through the same decode/dither/pack/thumbnail pipeline
  // uploadImage() uses — this route just overwrites the three KV blobs and
  // bumps that image's key_version. Idempotent: re-running it for an image
  // already on the new version is a safe no-op (no KV write, no D1 write).
  app.post("/admin/buckets/:id/rotate/:rotationId/reencrypt-image/:imageId", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const rotationId = c.req.param("rotationId");
    const imageId = c.req.param("imageId");
    if (!id || !rotationId || !imageId) return c.json({ error: "id, rotationId, and imageId are required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const rotation = await c.env.DB.prepare(
      "SELECT new_key_version FROM bucket_rotations WHERE id = ? AND bucket_id = ? AND status = 'in_progress'"
    )
      .bind(rotationId, id)
      .first<{ new_key_version: number }>();
    if (!rotation) return c.json({ error: "Rotation not found or already finalized" }, 404);

    const image = await c.env.DB.prepare("SELECT device_key, key_version FROM images WHERE id = ?")
      .bind(imageId)
      .first<{ device_key: string; key_version: number }>();
    if (!image || image.device_key !== id) return c.json({ error: "Not found" }, 404);

    if (image.key_version >= rotation.new_key_version) {
      // Already migrated (a retried or duplicate call) — safe no-op, don't
      // touch KV or D1 again.
      return c.json({ id: imageId, key_version: image.key_version, already_migrated: true });
    }

    const body = await c.req.parseBody();
    const fields = validateCiphertextUploadFields(body);
    if ("error" in fields) return c.json({ error: fields.error }, 400);
    const bytes = await readCiphertextUploadBytes(fields);
    if ("error" in bytes) return c.json({ error: bytes.error }, 400);
    const { rawBytes, variants } = bytes;

    // The client re-derives every board's `packed` from scratch (decode ->
    // dither -> pack, see admin.ts's reencryptOneImage()) rather than
    // reusing the existing ciphertext, so it re-decides compression fresh
    // too - trust whatever it reports the same way admin/images.ts's upload
    // route does, rather than assuming this image's previous
    // packed_encoding still applies.

    // Same for the keyed content hash (migrations/0020_image_content_hash.sql):
    // reencryptOneImage computes it under the NEW bucket key (and the pixels may
    // have changed anyway - the DEFAULT_CROP re-derive doesn't reproduce custom
    // crops), so refresh the column whenever the client sends one. COALESCE
    // keeps the old value for clients that didn't send a hash at all.
    if (fields.contentHash) {
      await c.env.DB.prepare("UPDATE images SET content_hash = ? WHERE id = ?")
        .bind(fields.contentHash, imageId)
        .run();
    }

    await Promise.all([
      putRawImage(c.env, id, imageId, rawBytes),
      ...BOARD_IDS.flatMap((board) => [
        putPackedImage(c.env, id, imageId, board, variants[board].packedBytes),
        putThumbnail(c.env, id, imageId, board, variants[board].thumbBytes),
      ]),
    ]);

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE images SET raw_bytes = ?, key_version = ? WHERE id = ?")
        .bind(rawBytes.byteLength, rotation.new_key_version, imageId),
      ...BOARD_IDS.map((board) =>
        c.env.DB.prepare(
          `INSERT INTO image_variants (image_id, board, packed_encoding, packed_hash, packed_bytes)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(image_id, board) DO UPDATE SET
             packed_encoding = excluded.packed_encoding,
             packed_hash = excluded.packed_hash,
             packed_bytes = excluded.packed_bytes`
        ).bind(imageId, board, fields.variants[board].packedEncoding, fields.variants[board].packedHash, variants[board].packedBytes.byteLength)
      ),
    ]);

    // The packed blobs (and their hashes) just changed under the same image
    // id — any cached rotation snapshot must be invalidated now, not left
    // for the next unrelated upload/delete, or a device could be served
    // this image's stale packed_hash/X-Bucket-Key-Version pairing.
    await invalidateRotationCache(c.env, id);
    await invalidateRotationCacheForBucketConsumers(c.env, id);

    return c.json({ id: imageId, key_version: rotation.new_key_version });
  });

  // Client supplies a fresh wrap of the new key for every CURRENTLY
  // authorized principal (owner + live bucket_shares + live device_buckets,
  // recomputed here rather than reused from rotate/start — see
  // lib/bucket-keys.ts's computeAuthorizedPrincipals). Refuses unless every
  // image is confirmed on the new version.
  app.post("/admin/buckets/:id/rotate/:rotationId/finalize", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const rotationId = c.req.param("rotationId");
    if (!id || !rotationId) return c.json({ error: "id and rotationId are required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id, key_version, is_public FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null; key_version: number; is_public: number }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const rotation = await c.env.DB.prepare(
      "SELECT new_key_version FROM bucket_rotations WHERE id = ? AND bucket_id = ? AND status = 'in_progress'"
    )
      .bind(rotationId, id)
      .first<{ new_key_version: number }>();
    if (!rotation) return c.json({ error: "Rotation not found or already finalized" }, 404);

    const pendingCount = await c.env.DB.prepare("SELECT COUNT(*) AS cnt FROM images WHERE device_key = ? AND key_version < ?")
      .bind(id, rotation.new_key_version)
      .first<{ cnt: number }>();
    if ((pendingCount?.cnt ?? 0) > 0) {
      return c.json(
        { error: "Not every image has been re-encrypted to the new key version yet", pending: pendingCount?.cnt ?? 0 },
        409
      );
    }

    const body = await c.req
      .json<{ user_keys?: Record<string, unknown>; device_keys?: Record<string, unknown>; public_key_raw?: string }>()
      .catch(() => ({}) as never);

    // A public bucket's key isn't wrapped for anyone (migrations/
    // 0018_public_buckets.sql) — it's just not kept secret — so finalizing a
    // rotation on one must also refresh buckets.public_key_raw to the new raw
    // key, in the SAME batch as the key_version bump below. Skipping this
    // would leave every non-owner reader (who has no bucket_keys row to begin
    // with, by design) permanently stuck decrypting with the old, now-stale
    // key after rotation — the rotation would silently break public reads
    // instead of revoking anything.
    if (bucket.is_public === 1 && !isValidRawAesKeyB64(body.public_key_raw)) {
      return c.json(
        { error: "public_key_raw (the new raw key, 44-char base64 of the 32-byte AES-256 key) is required to finalize a public bucket's rotation" },
        400
      );
    }

    // Recomputed HERE, not reused from rotate/start — a share accepted or a
    // device assigned mid-rotation must still receive a new-version wrap, and
    // one removed mid-rotation must not.
    const [shareRows, deviceRows] = await Promise.all([
      c.env.DB.prepare("SELECT user_id FROM bucket_shares WHERE bucket_id = ?").bind(id).all<{ user_id: string }>(),
      c.env.DB.prepare("SELECT device_mac FROM device_buckets WHERE bucket_id = ?").bind(id).all<{ device_mac: string }>(),
    ]);
    const principals = computeAuthorizedPrincipals(
      bucket.owner_id,
      shareRows.results.map((r) => r.user_id),
      deviceRows.results.map((r) => r.device_mac)
    );

    const resolvedKeys: Array<{ principal: PrincipalRef; key: WrappedBucketKey }> = [];
    for (const principal of principals) {
      const raw = principal.type === "user" ? body.user_keys?.[principal.id] : body.device_keys?.[principal.id];
      const key = parseWrappedBucketKey(raw);
      if (!key) {
        return c.json(
          {
            error: `Missing a new-version wrapped key for ${principal.type} ${principal.id} — every currently-authorized principal must be re-wrapped to finalize.`,
          },
          400
        );
      }
      resolvedKeys.push({ principal, key });
    }

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.batch([
      ...resolvedKeys.map(({ principal, key }) =>
        c.env.DB.prepare(
          `INSERT INTO bucket_keys (bucket_id, principal_type, principal_id, key_version, ephemeral_pub, nonce, ciphertext, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bucket_id, principal_type, principal_id, key_version) DO UPDATE SET
             ephemeral_pub = excluded.ephemeral_pub,
             nonce = excluded.nonce,
             ciphertext = excluded.ciphertext,
             created_at = excluded.created_at`
        ).bind(id, principal.type, principal.id, rotation.new_key_version, key.ephemeralPub, key.nonce, key.ciphertext, now)
      ),
      // The actual revocation: every OLD-version wrap, for every principal —
      // including one dropped since rotate/start, who has no resolvedKeys
      // entry above and would otherwise keep indefinite access to the old key.
      c.env.DB.prepare("DELETE FROM bucket_keys WHERE bucket_id = ? AND key_version = ?").bind(id, bucket.key_version),
      bucket.is_public === 1
        ? c.env.DB.prepare("UPDATE buckets SET key_version = ?, public_key_raw = ? WHERE id = ?").bind(
            rotation.new_key_version,
            body.public_key_raw,
            id
          )
        : c.env.DB.prepare("UPDATE buckets SET key_version = ? WHERE id = ?").bind(rotation.new_key_version, id),
      c.env.DB.prepare("UPDATE bucket_rotations SET status = 'completed', completed_at = ? WHERE id = ?").bind(now, rotationId),
    ]);

    return c.json({ finalized: true, bucket_id: id, key_version: rotation.new_key_version });
  });
}
