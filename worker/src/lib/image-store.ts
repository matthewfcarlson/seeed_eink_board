import type { Env } from "../types";

/** KV keys for the two blobs kept per catalog image — see plan §Storage (KV-only). */
export const imageStoreKeys = {
  raw: (deviceKey: string, imageId: string) => `img:raw:${deviceKey}:${imageId}`,
  packed: (deviceKey: string, imageId: string) => `img:packed:${deviceKey}:${imageId}`,
};

async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/**
 * The packed 4bpp binary is low-entropy (only 6 distinct nibble values) and
 * compresses very well, so it's always gzipped in KV and decompressed on the hot
 * path. Raw originals are typically already-compressed formats (JPEG/PNG/WebP),
 * so they're stored as-is — gzipping them again buys almost nothing.
 */
export async function putPackedImage(
  env: Env,
  deviceKey: string,
  imageId: string,
  packedBytes: Uint8Array
): Promise<void> {
  const compressed = await gzip(packedBytes);
  await env.KV.put(imageStoreKeys.packed(deviceKey, imageId), compressed);
}

export async function getPackedImage(
  env: Env,
  deviceKey: string,
  imageId: string
): Promise<ArrayBuffer | null> {
  const compressed = await env.KV.get(imageStoreKeys.packed(deviceKey, imageId), "arrayBuffer");
  if (!compressed) return null;
  return gunzip(compressed);
}

export async function putRawImage(
  env: Env,
  deviceKey: string,
  imageId: string,
  rawBytes: Uint8Array
): Promise<void> {
  await env.KV.put(imageStoreKeys.raw(deviceKey, imageId), rawBytes);
}

export async function deleteImageBlobs(env: Env, deviceKey: string, imageId: string): Promise<void> {
  await Promise.all([
    env.KV.delete(imageStoreKeys.raw(deviceKey, imageId)),
    env.KV.delete(imageStoreKeys.packed(deviceKey, imageId)),
  ]);
}
