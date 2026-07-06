import { DEFAULT_DEVICE_KEY, type Env, type ImageMeta, type RotationSnapshot } from "../types";
import { kvKeys } from "./kv-keys";

async function loadImagesForKey(env: Env, deviceKey: string): Promise<ImageMeta[]> {
  const imagesResult = await env.DB.prepare(
    `SELECT id, filename, packed_hash, packed_bytes
     FROM images WHERE device_key = ? ORDER BY filename ASC`
  )
    .bind(deviceKey)
    .all<{
      id: string;
      filename: string;
      packed_hash: string;
      packed_bytes: number;
    }>();

  return imagesResult.results.map((row) => ({
    id: row.id,
    filename: row.filename,
    packedHash: row.packed_hash,
    packedBytes: row.packed_bytes,
    sourceDeviceKey: deviceKey,
  }));
}

/** Registered devices default to merging in the shared 'default' bucket's images
 *  (see migrations/0003_include_default_images.sql) — this can be toggled off per device. */
async function shouldIncludeDefaultImages(env: Env, deviceKey: string): Promise<boolean> {
  if (deviceKey === DEFAULT_DEVICE_KEY) return false;
  const row = await env.DB.prepare("SELECT include_default_images FROM devices WHERE mac = ?")
    .bind(deviceKey)
    .first<{ include_default_images: number }>();
  return row?.include_default_images === 1;
}

/**
 * KV holds the live, hot-path rotation cursor. D1's rotation_state table is a
 * durable mirror written asynchronously (via ctx.waitUntil) — see plan §KV design.
 * If KV is missing the key (cold start / eviction), we rebuild from D1 and re-seed KV.
 */
async function loadSnapshotFromD1(env: Env, deviceKey: string): Promise<RotationSnapshot> {
  const ownImages = await loadImagesForKey(env, deviceKey);
  let images = ownImages;
  if (await shouldIncludeDefaultImages(env, deviceKey)) {
    const defaultImages = await loadImagesForKey(env, DEFAULT_DEVICE_KEY);
    images = [...ownImages, ...defaultImages].sort((a, b) => a.filename.localeCompare(b.filename));
  }

  const stateRow = await env.DB.prepare(
    `SELECT current_index, last_returned FROM rotation_state WHERE device_key = ?`
  )
    .bind(deviceKey)
    .first<{ current_index: number; last_returned: string | null }>();

  return {
    currentIndex: stateRow?.current_index ?? 0,
    lastReturned: stateRow?.last_returned ?? null,
    images,
  };
}

export async function getRotationSnapshot(env: Env, deviceKey: string): Promise<RotationSnapshot> {
  const cacheKey = kvKeys.rotation(deviceKey);
  const cached = await env.KV.get<RotationSnapshot>(cacheKey, "json");
  if (cached) return cached;

  const snapshot = await loadSnapshotFromD1(env, deviceKey);
  await env.KV.put(cacheKey, JSON.stringify(snapshot));
  return snapshot;
}

/** Call after any admin image upload/delete for `deviceKey` so the next request re-reads D1. */
export async function invalidateRotationCache(env: Env, deviceKey: string): Promise<void> {
  await env.KV.delete(kvKeys.rotation(deviceKey));
}

/** Call in addition to invalidateRotationCache('default') after any upload/delete against
 *  the shared 'default' bucket — every device merging it in has its own cached snapshot
 *  that also needs busting, since it embeds default's images at cache-population time. */
export async function invalidateRotationCacheForDefaultConsumers(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT mac FROM devices WHERE include_default_images = 1").all<{
    mac: string;
  }>();
  await Promise.all(rows.results.map((row) => invalidateRotationCache(env, row.mac)));
}

/** The image that would be served next, without advancing. Never mutates state. */
export function peekPendingImage(
  snapshot: RotationSnapshot
): { image: ImageMeta; index: number } | null {
  if (snapshot.images.length === 0) return null;
  const index = snapshot.currentIndex >= snapshot.images.length ? 0 : snapshot.currentIndex;
  const image = snapshot.images[index];
  if (!image) return null;
  return { image, index };
}

/**
 * Advance the rotation cursor after a successful /image_packed response.
 * Writes KV synchronously (the hot-path source of truth) and returns a thunk the
 * caller should pass to ctx.waitUntil() to mirror the change into D1 asynchronously.
 */
export async function markServed(
  env: Env,
  deviceKey: string,
  snapshot: RotationSnapshot,
  servedIndex: number,
  servedImageId: string
): Promise<() => Promise<void>> {
  const nextIndex = (servedIndex + 1) % snapshot.images.length;
  const updated: RotationSnapshot = {
    ...snapshot,
    currentIndex: nextIndex,
    lastReturned: servedImageId,
  };

  await env.KV.put(kvKeys.rotation(deviceKey), JSON.stringify(updated));

  return async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO rotation_state (device_key, current_index, last_returned, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_key) DO UPDATE SET
         current_index = excluded.current_index,
         last_returned = excluded.last_returned,
         updated_at = excluded.updated_at`
    )
      .bind(deviceKey, nextIndex, servedImageId, now)
      .run();
  };
}
