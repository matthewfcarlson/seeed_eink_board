import type { Hono } from "hono";
import type { Env } from "../../types";
import { normalizeMac } from "../../lib/mac";
import { invalidateDeviceCache } from "../../lib/auth-device";
import { getRotationSnapshot, invalidateRotationCache } from "../../lib/rotation";
import { getThumbnailCiphertextB64 } from "../../lib/image-store";
import { requireAdmin } from "../../lib/admin-middleware";
import { assertBucketReadAccess } from "../../lib/bucket-access";
import { deleteBucketKey, parseWrappedBucketKey, upsertBucketKey } from "../../lib/bucket-keys";

// The device's self-generated HMAC key (hex), scanned off its own display via the
// registration QR — see lib/device-signature.ts. Loose length bound since the
// firmware picks the byte count, not this validator; just guards against empty/
// junk values getting stored as a secret.
const SECRET_PATTERN = /^[0-9a-f]{16,64}$/i;

/** What a device was last successfully sent, per its rotation cursor (see lib/rotation.ts's
 *  markServed) — not necessarily what's on the physical screen. markServed advances the
 *  cursor as soon as the response body starts streaming, so a device that dies mid-download
 *  or mid-refresh will still show as having "sent" the new image here, even though the e-ink
 *  panel — which holds its last completed refresh through power loss — is still showing the
 *  previous one. Falls back to a thumbnail-less entry if that image has since been deleted
 *  from its bucket(s). */
async function buildCurrentImage(env: Env, deviceKey: string) {
  const snapshot = await getRotationSnapshot(env, deviceKey);
  if (!snapshot.lastReturned) return null;
  const image = snapshot.images.find((img) => img.id === snapshot.lastReturned);
  if (!image) return { id: null, filename: snapshot.lastReturned, source_bucket_id: null, thumbnail_ciphertext_b64: null };
  return {
    id: image.id,
    filename: image.filename,
    // Which bucket's key decrypts this thumbnail — a device can subscribe to
    // several, so its current image isn't necessarily from its own bucket id.
    source_bucket_id: image.sourceDeviceKey,
    thumbnail_ciphertext_b64: await getThumbnailCiphertextB64(env, image.sourceDeviceKey, image.id),
  };
}

export function registerAdminDeviceRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/devices", requireAdmin, async (c) => {
    const body = await c.req
      .json<{ mac?: string; label?: string; secret?: string; sharing_public_key?: string }>()
      .catch(() => ({}) as never);
    if (!body.mac) return c.json({ error: "mac is required" }, 400);
    if (body.secret !== undefined && !SECRET_PATTERN.test(body.secret)) {
      return c.json({ error: "secret must be a hex string" }, 400);
    }

    const mac = normalizeMac(body.mac);
    const user = c.var.user;

    const existing = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();
    if (existing && existing.user_id !== user.id) {
      return c.json({ error: "Device already registered to another user" }, 409);
    }

    const now = Math.floor(Date.now() / 1000);
    // COALESCE keeps any existing secret when the caller doesn't send one (e.g. an
    // admin editing just the label) rather than accidentally locking the device out.
    // last_nonce resets to 0 whenever a *new* secret is bound: a fresh secret means
    // the device's NVS was wiped (see ConfigManager::ensureDeviceSecret()), so its
    // nonce counter restarted at 0 too — carrying over the old high-water mark here
    // would reject every request from the "new" device as a replay forever.
    // sharing_public_key: the device's own P-256 public key, generated on first
    // boot and surfaced during provisioning/claim (see root CLAUDE.md's
    // encrypted-buckets plan) — same out-of-band delivery pattern as `secret`.
    // COALESCE'd the same way: never overwritten once set by a stray claim
    // retry that omits it.
    await c.env.DB.prepare(
      `INSERT INTO devices (mac, user_id, label, secret, last_nonce, created_at, sharing_public_key)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(mac) DO UPDATE SET
         label = excluded.label,
         secret = COALESCE(excluded.secret, devices.secret),
         last_nonce = CASE WHEN excluded.secret IS NOT NULL THEN 0 ELSE devices.last_nonce END,
         sharing_public_key = COALESCE(devices.sharing_public_key, excluded.sharing_public_key)`
    )
      .bind(mac, user.id, body.label ?? null, body.secret ?? null, now, body.sharing_public_key ?? null)
      .run();

    await invalidateDeviceCache(c.env, mac);
    return c.json({ mac, label: body.label ?? null }, 201);
  });

  app.get("/admin/devices", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT mac, label, created_at, last_seen_at, last_seen_ip, last_battery_voltage, last_battery_at, running_firmware_version, board, sharing_public_key FROM devices WHERE user_id = ?"
    )
      .bind(c.var.user.id)
      .all<Record<string, unknown> & { mac: string }>();

    // One extra query, grouped in JS, rather than N+1 per device.
    const bucketRows =
      rows.results.length > 0
        ? await c.env.DB.prepare(
            `SELECT device_mac, bucket_id FROM device_buckets WHERE device_mac IN (${rows.results.map(() => "?").join(",")})`
          )
            .bind(...rows.results.map((row) => row.mac))
            .all<{ device_mac: string; bucket_id: string }>()
        : { results: [] as { device_mac: string; bucket_id: string }[] };
    const bucketIdsByMac = new Map<string, string[]>();
    for (const row of bucketRows.results) {
      const list = bucketIdsByMac.get(row.device_mac) ?? [];
      list.push(row.bucket_id);
      bucketIdsByMac.set(row.device_mac, list);
    }

    const devices = await Promise.all(
      rows.results.map(async (row) => ({
        ...row,
        bucket_ids: bucketIdsByMac.get(row.mac) ?? [],
        current_image: await buildCurrentImage(c.env, row.mac),
      }))
    );
    return c.json({ devices });
  });

  app.patch("/admin/devices/:mac", requireAdmin, async (c) => {
    const macParam = c.req.param("mac");
    if (!macParam) return c.json({ error: "mac is required" }, 400);
    const mac = normalizeMac(macParam);
    const body = await c.req.json<{ label?: string }>().catch(() => ({}) as never);

    const row = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.user_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    if (body.label !== undefined) {
      await c.env.DB.prepare("UPDATE devices SET label = ? WHERE mac = ?").bind(body.label, mac).run();
    }

    return c.json({ mac, label: body.label });
  });

  // Replaces this device's full bucket subscription set. Every id must be
  // readable by the caller — owned, shared, or public (migrations/
  // 0018_public_buckets.sql) — see lib/bucket-access.ts's assertBucketReadAccess.
  // `keys`: the caller's own wrap of each bucket's raw key for this device's
  // sharing_public_key (see client/crypto.ts's wrapKeyFor) — the Worker never
  // computes these itself, it only stores what the browser hands it. For an
  // owned/shared bucket the browser already holds the raw key via its own
  // bucket_keys wrap; for a public bucket it doesn't own, it reads the raw
  // key straight from that bucket's public_key_raw instead (surfaced by
  // GET /admin/buckets) — same wrapKeyFor call either way, so this route
  // can't tell (and doesn't need to) which source a given key came from.
  // Required for every bucket_id in the new set; buckets dropped from the set
  // have their now-stale device key cleaned up (cosmetic, not a real
  // revocation — see root CLAUDE.md's Non-goals).
  app.patch("/admin/devices/:mac/buckets", requireAdmin, async (c) => {
    const macParam = c.req.param("mac");
    if (!macParam) return c.json({ error: "mac is required" }, 400);
    const mac = normalizeMac(macParam);
    const body = await c.req
      .json<{ bucket_ids?: string[]; keys?: Record<string, unknown> }>()
      .catch(() => ({}) as never);
    if (!Array.isArray(body.bucket_ids)) return c.json({ error: "bucket_ids must be an array" }, 400);

    const row = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.user_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const bucketIds = [...new Set(body.bucket_ids)];
    const wrappedKeys = new Map<string, ReturnType<typeof parseWrappedBucketKey>>();
    const bucketKeyVersions = new Map<string, number>();
    for (const bucketId of bucketIds) {
      // Read-shaped: a caller may assign a public bucket they don't own to
      // their own device — this only reads that bucket's key (already public),
      // never writes anything to the bucket itself. See lib/bucket-access.ts.
      if (!(await assertBucketReadAccess(c.env, bucketId, c.var.user.id))) {
        return c.json({ error: `Forbidden: no access to bucket ${bucketId}` }, 403);
      }
      const key = parseWrappedBucketKey(body.keys?.[bucketId]);
      if (!key) return c.json({ error: `keys.${bucketId} (wrapped bucket key for this device) is required` }, 400);
      wrappedKeys.set(bucketId, key);
      // Assigning a bucket always wraps its CURRENT version's key for the
      // device — mid-rotation that's still the old version until finalize
      // bumps buckets.key_version, which is correct: a newly-assigned device
      // needs whatever version the bucket's images are actually encrypted
      // under right now.
      const bucket = await c.env.DB.prepare("SELECT key_version FROM buckets WHERE id = ?")
        .bind(bucketId)
        .first<{ key_version: number }>();
      bucketKeyVersions.set(bucketId, bucket?.key_version ?? 1);
    }

    const previousBucketIds = await c.env.DB.prepare("SELECT bucket_id FROM device_buckets WHERE device_mac = ?")
      .bind(mac)
      .all<{ bucket_id: string }>();

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM device_buckets WHERE device_mac = ?").bind(mac),
      ...bucketIds.map((bucketId) =>
        c.env.DB.prepare("INSERT INTO device_buckets (device_mac, bucket_id) VALUES (?, ?)").bind(mac, bucketId)
      ),
    ]);
    await Promise.all(
      bucketIds.map((bucketId) => upsertBucketKey(c.env, bucketId, "device", mac, wrappedKeys.get(bucketId)!, bucketKeyVersions.get(bucketId)!))
    );
    const droppedBucketIds = previousBucketIds.results.map((r) => r.bucket_id).filter((id) => !bucketIds.includes(id));
    await Promise.all(droppedBucketIds.map((bucketId) => deleteBucketKey(c.env, bucketId, "device", mac)));

    await invalidateRotationCache(c.env, mac);
    return c.json({ mac, bucket_ids: bucketIds });
  });

  app.delete("/admin/devices/:mac", requireAdmin, async (c) => {
    const macParam = c.req.param("mac");
    if (!macParam) return c.json({ error: "mac is required" }, 400);
    const mac = normalizeMac(macParam);
    const row = await c.env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
      .bind(mac)
      .first<{ user_id: string | null }>();

    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.user_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM device_buckets WHERE device_mac = ?").bind(mac),
      c.env.DB.prepare("DELETE FROM bucket_keys WHERE principal_type = 'device' AND principal_id = ?").bind(mac),
      c.env.DB.prepare("DELETE FROM devices WHERE mac = ?").bind(mac),
    ]);
    await invalidateDeviceCache(c.env, mac);
    return c.json({ deleted: mac });
  });
}
