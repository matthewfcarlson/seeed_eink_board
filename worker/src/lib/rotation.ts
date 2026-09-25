import type { Env, ImageMeta, RotationSnapshot } from "../types";
import { kvKeys } from "./kv-keys";

/** How many served image ids we keep around per device. The pick only ever
 *  consults the newest recentWindow(imageCount) of them; the rest are kept so
 *  the window can grow again after images are added, without a cold history.
 *  Capped because this list rides along in every KV snapshot read. */
const RECENT_HISTORY_CAP = 32;

/** How far back "don't show me that again yet" reaches: about half the
 *  collection. 1 image -> 0 (the only image has to repeat); 2 -> 1 (strict
 *  alternation); 10 -> 5; 100 -> capped at RECENT_HISTORY_CAP. */
function recentWindow(imageCount: number): number {
  return Math.min(RECENT_HISTORY_CAP, Math.floor(imageCount / 2));
}

async function loadImagesForKey(env: Env, deviceKey: string): Promise<ImageMeta[]> {
  const imagesResult = await env.DB.prepare(
    `SELECT id, filename, key_version FROM images WHERE device_key = ? ORDER BY filename ASC`
  )
    .bind(deviceKey)
    .all<{ id: string; filename: string; key_version: number }>();

  return imagesResult.results.map((row) => ({
    id: row.id,
    filename: row.filename,
    sourceDeviceKey: deviceKey,
    keyVersion: row.key_version,
  }));
}

/** Bucket ids a device's rotation merges together — see migrations/0007_buckets.sql.
 *  Only ever called with a real, registered device's mac: routes/image-packed.ts
 *  and routes/hash.ts short-circuit to the QR-registration image before ever
 *  reaching rotation for an unclaimed device, so there's no 'default'-deviceKey
 *  case to special-case here (see lib/auth-device.ts's resolveDeviceKey). */
async function getSubscribedBucketIds(env: Env, deviceKey: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT bucket_id FROM device_buckets WHERE device_mac = ?")
    .bind(deviceKey)
    .all<{ bucket_id: string }>();
  return rows.results.map((row) => row.bucket_id);
}

function parseRecentImageIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_HISTORY_CAP);
  } catch {
    return []; // Corrupt history just means a less-spaced-out pick, never a 500.
  }
}

/**
 * KV holds the live, hot-path rotation state. D1's rotation_state table is a
 * durable mirror written asynchronously (via ctx.waitUntil) — see plan §KV design.
 * If KV is missing the key (cold start / eviction), we rebuild from D1 and re-seed KV.
 */
async function loadSnapshotFromD1(env: Env, deviceKey: string): Promise<RotationSnapshot> {
  const bucketIds = await getSubscribedBucketIds(env, deviceKey);
  const perBucketImages = await Promise.all(bucketIds.map((bucketId) => loadImagesForKey(env, bucketId)));
  const images = perBucketImages.flat().sort((a, b) => a.filename.localeCompare(b.filename));

  const stateRow = await env.DB.prepare(
    `SELECT last_returned, last_bucket_id, recent_image_ids FROM rotation_state WHERE device_key = ?`
  )
    .bind(deviceKey)
    .first<{ last_returned: string | null; last_bucket_id: string | null; recent_image_ids: string | null }>();

  return {
    lastReturned: stateRow?.last_returned ?? null,
    lastBucketId: stateRow?.last_bucket_id ?? null,
    recentImageIds: parseRecentImageIds(stateRow?.recent_image_ids),
    images,
  };
}

export async function getRotationSnapshot(env: Env, deviceKey: string): Promise<RotationSnapshot> {
  const cacheKey = kvKeys.rotation(deviceKey);
  const cached = await env.KV.get<Partial<RotationSnapshot>>(cacheKey, "json");
  // Field-by-field rather than `return cached`: a snapshot cached by an older
  // deploy (sequential cursor, no history) is still a usable starting point.
  if (cached) {
    return {
      lastReturned: cached.lastReturned ?? null,
      lastBucketId: cached.lastBucketId ?? null,
      recentImageIds: cached.recentImageIds ?? [],
      images: cached.images ?? [],
    };
  }

  const snapshot = await loadSnapshotFromD1(env, deviceKey);
  await env.KV.put(cacheKey, JSON.stringify(snapshot));
  return snapshot;
}

/** Call after any admin image upload/delete for `deviceKey` so the next request re-reads D1. */
export async function invalidateRotationCache(env: Env, deviceKey: string): Promise<void> {
  await env.KV.delete(kvKeys.rotation(deviceKey));
}

/** Call in addition to invalidateRotationCache(bucketId) after any upload/delete against
 *  a bucket — every device subscribed to it has its own cached snapshot that also needs
 *  busting, since it embeds this bucket's images at cache-population time. */
export async function invalidateRotationCacheForBucketConsumers(env: Env, bucketId: string): Promise<void> {
  const rows = await env.DB.prepare("SELECT device_mac FROM device_buckets WHERE bucket_id = ?")
    .bind(bucketId)
    .all<{ device_mac: string }>();
  await Promise.all(rows.results.map((row) => invalidateRotationCache(env, row.device_mac)));
}

/** FNV-1a over the state the pick is derived from. Not a security hash — it
 *  just has to smear neighbouring states (one image id different) into
 *  unrelated seeds. */
function seedFor(deviceKey: string, snapshot: RotationSnapshot): number {
  const material = [
    deviceKey, // two frames in one house share buckets; they must not share picks
    snapshot.lastReturned ?? "",
    snapshot.recentImageIds.join(","),
    snapshot.images.map((img) => img.id).join(","),
  ].join("|");

  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — a tiny seeded PRNG. Workers have crypto.getRandomValues, but the
 *  pick has to be *reproducible from stored state*: /hash and the /image_packed
 *  that follows it must agree on which image is next (and /current must report
 *  that same one), and only /image_packed writes state. Seeding from the
 *  snapshot gets that for free — the state changes on every serve, so the
 *  sequence still looks shuffled. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The image that would be served next, without advancing. Never mutates state,
 * and returns the same image for the same snapshot — see mulberry32 above.
 *
 * "Human random" rather than sequential or uniform-random-over-images:
 *  - Never twice in a row from the same bucket, as long as some other
 *    subscribed bucket has an image to offer. Someone flipping through their
 *    own albums by hand doesn't serve one album to exhaustion.
 *  - Bucket chosen uniformly *per bucket*, not weighted by image count, so a
 *    500-photo bucket doesn't drown out a 5-photo one. The flip side: with two
 *    buckets, each gets every other slot however lopsided they are.
 *  - Within the chosen bucket, images inside the recency window are skipped, so
 *    the same photo doesn't come back around immediately.
 */
export function peekPendingImage(deviceKey: string, snapshot: RotationSnapshot): ImageMeta | null {
  if (snapshot.images.length === 0) return null;

  // Insertion order follows snapshot.images (filename-sorted), so bucket order
  // — and therefore the pick — is stable across requests.
  const byBucket = new Map<string, ImageMeta[]>();
  for (const img of snapshot.images) {
    const pool = byBucket.get(img.sourceDeviceKey);
    if (pool) pool.push(img);
    else byBucket.set(img.sourceDeviceKey, [img]);
  }

  const random = mulberry32(seedFor(deviceKey, snapshot));

  let bucketIds = [...byBucket.keys()];
  if (bucketIds.length > 1 && snapshot.lastBucketId) {
    const others = bucketIds.filter((bucketId) => bucketId !== snapshot.lastBucketId);
    if (others.length > 0) bucketIds = others;
  }
  const pool = byBucket.get(bucketIds[Math.floor(random() * bucketIds.length)]!)!;

  // A bucket smaller than the recency window can't avoid repeats — fall back to
  // the whole bucket rather than abandoning the bucket rule to dodge one.
  const recent = new Set(snapshot.recentImageIds.slice(0, recentWindow(snapshot.images.length)));
  const fresh = pool.filter((img) => !recent.has(img.id));
  const candidates = fresh.length > 0 ? fresh : pool;
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}

/**
 * Record a successful /image_packed response, which is what makes the next
 * peekPendingImage() pick something else (there's no cursor to bump — the pick
 * is derived from this state).
 * Writes KV synchronously (the hot-path source of truth) and returns a thunk the
 * caller should pass to ctx.waitUntil() to mirror the change into D1 asynchronously.
 */
export async function markServed(
  env: Env,
  deviceKey: string,
  snapshot: RotationSnapshot,
  servedImage: ImageMeta
): Promise<() => Promise<void>> {
  // Drop ids that are no longer in any subscribed bucket along the way: a
  // deleted image left in the history would otherwise sit in the recency window
  // blocking nothing, and the window is sized in ids, so ghosts cost spacing.
  const live = new Set(snapshot.images.map((img) => img.id));
  const recentImageIds = [
    servedImage.id,
    ...snapshot.recentImageIds.filter((id) => id !== servedImage.id && live.has(id)),
  ].slice(0, RECENT_HISTORY_CAP);
  const updated: RotationSnapshot = {
    ...snapshot,
    lastReturned: servedImage.id,
    lastBucketId: servedImage.sourceDeviceKey,
    recentImageIds,
  };

  await env.KV.put(kvKeys.rotation(deviceKey), JSON.stringify(updated));

  return async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO rotation_state (device_key, last_returned, last_bucket_id, recent_image_ids, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_key) DO UPDATE SET
         last_returned = excluded.last_returned,
         last_bucket_id = excluded.last_bucket_id,
         recent_image_ids = excluded.recent_image_ids,
         updated_at = excluded.updated_at`
    )
      .bind(deviceKey, servedImage.id, servedImage.sourceDeviceKey, JSON.stringify(recentImageIds), now)
      .run();
  };
}
