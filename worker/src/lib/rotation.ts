import type { Env, ImageMeta, RotationSnapshot } from "../types";
import { kvKeys } from "./kv-keys";

/**
 * KV holds the live, hot-path rotation cursor. D1's rotation_state table is a
 * durable mirror written asynchronously (via ctx.waitUntil) — see plan §KV design.
 * If KV is missing the key (cold start / eviction), we rebuild from D1 and re-seed KV.
 */
async function loadSnapshotFromD1(env: Env, deviceKey: string): Promise<RotationSnapshot> {
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

  const images: ImageMeta[] = imagesResult.results.map((row) => ({
    id: row.id,
    filename: row.filename,
    packedHash: row.packed_hash,
    packedBytes: row.packed_bytes,
  }));

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
