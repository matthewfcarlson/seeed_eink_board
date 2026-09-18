import type { Env } from "../types";
import { BOARD_IDS, type BoardId, type PackedEncoding } from "./media-constants";

/** KV keys for the blobs kept per catalog image — see plan §Storage (KV-only).
 *  `packed`/`thumb` are per-board (migrations/0019_image_board_variants.sql -
 *  a bucket can mix EE02/EE04 devices, so each image needs one rendition per
 *  board); `raw` is the single as-uploaded original, shared by every variant. */
export const imageStoreKeys = {
  raw: (deviceKey: string, imageId: string) => `img:raw:${deviceKey}:${imageId}`,
  packed: (deviceKey: string, imageId: string, board: BoardId) => `img:packed:${deviceKey}:${imageId}:${board}`,
  thumb: (deviceKey: string, imageId: string, board: BoardId) => `img:thumb:${deviceKey}:${imageId}:${board}`,
};

/**
 * Every blob stored here is opaque AES-256-GCM ciphertext (nonce prepended),
 * encrypted client-side under a bucket key the Worker never holds — see root
 * CLAUDE.md's encrypted-buckets plan. The Worker's job is purely storage: no
 * decode, no dither, no compression, and (unlike the pre-encryption version of
 * this file) no gzip either — ciphertext is high-entropy by design, so
 * compressing it here would buy nothing. If a blob is ever compressed, that
 * happens client-side, before encryption, entirely outside this file's view.
 */
export async function putPackedImage(env: Env, deviceKey: string, imageId: string, board: BoardId, ciphertext: Uint8Array): Promise<void> {
  await env.KV.put(imageStoreKeys.packed(deviceKey, imageId, board), ciphertext);
}

export async function getPackedImage(env: Env, deviceKey: string, imageId: string, board: BoardId): Promise<ArrayBuffer | null> {
  return env.KV.get(imageStoreKeys.packed(deviceKey, imageId, board), "arrayBuffer");
}

export async function putRawImage(env: Env, deviceKey: string, imageId: string, ciphertext: Uint8Array): Promise<void> {
  await env.KV.put(imageStoreKeys.raw(deviceKey, imageId), ciphertext);
}

/** Ciphertext of the original as-uploaded bytes, served back for the
 *  dashboard's hover-to-enlarge preview — the browser decrypts it, the Worker
 *  never does. */
export async function getRawImage(env: Env, deviceKey: string, imageId: string): Promise<ArrayBuffer | null> {
  return env.KV.get(imageStoreKeys.raw(deviceKey, imageId), "arrayBuffer");
}

export async function putThumbnail(env: Env, deviceKey: string, imageId: string, board: BoardId, ciphertext: Uint8Array): Promise<void> {
  await env.KV.put(imageStoreKeys.thumb(deviceKey, imageId, board), ciphertext);
}

/** Ciphertext of one board's thumbnail, for the dashboard gallery to decrypt
 *  and render client-side. Returns null if no thumbnail was ever stored for
 *  this (image, board) pair (e.g. it predates this feature). */
export async function getThumbnail(env: Env, deviceKey: string, imageId: string, board: BoardId): Promise<ArrayBuffer | null> {
  return env.KV.get(imageStoreKeys.thumb(deviceKey, imageId, board), "arrayBuffer");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Base64 of getThumbnail's ciphertext — the shape every admin route actually
 *  wants to embed in a JSON response. Named `..._ciphertext_b64`, not
 *  `..._data_url` (its pre-encryption name), so every call site is honest
 *  that this isn't directly renderable without a client-side decrypt first. */
export async function getThumbnailCiphertextB64(env: Env, deviceKey: string, imageId: string, board: BoardId): Promise<string | null> {
  const bytes = await getThumbnail(env, deviceKey, imageId, board);
  return bytes ? bytesToBase64(new Uint8Array(bytes)) : null;
}

export async function deleteImageBlobs(env: Env, deviceKey: string, imageId: string): Promise<void> {
  await Promise.all([
    env.KV.delete(imageStoreKeys.raw(deviceKey, imageId)),
    ...BOARD_IDS.flatMap((board) => [
      env.KV.delete(imageStoreKeys.packed(deviceKey, imageId, board)),
      env.KV.delete(imageStoreKeys.thumb(deviceKey, imageId, board)),
    ]),
  ]);
}

export interface ImageVariant {
  packedHash: string;
  packedBytes: number;
  packedEncoding: PackedEncoding;
}

/** This image's packed-variant metadata for one board, or null if it was
 *  never generated for that board (e.g. it predates per-board variants and
 *  was never re-uploaded/re-derived since - see migrations/
 *  0019_image_board_variants.sql's backfill, which only covers EE02). */
export async function getImageVariant(env: Env, imageId: string, board: BoardId): Promise<ImageVariant | null> {
  const row = await env.DB.prepare("SELECT packed_hash, packed_bytes, packed_encoding FROM image_variants WHERE image_id = ? AND board = ?")
    .bind(imageId, board)
    .first<{ packed_hash: string; packed_bytes: number; packed_encoding: PackedEncoding }>();
  return row ? { packedHash: row.packed_hash, packedBytes: row.packed_bytes, packedEncoding: row.packed_encoding } : null;
}
