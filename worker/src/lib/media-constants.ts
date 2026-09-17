// Split out of types.ts so client/ code (the browser-side image pipeline) can
// import these without dragging in types.ts's `Env` interface, which
// references ambient Cloudflare Workers types (D1Database/KVNamespace) that
// don't exist — and shouldn't be assumed to — in a browser TS program. Plain
// re-exported from types.ts for every existing Worker-side import.

export const PACKED_BYTES = 960000;

// Buffer is 1600x1200 landscape to match firmware; source images are fit to
// 1200x1600 portrait first, then rotated 90° CW.
export const BUFFER_WIDTH = 1600;
export const BUFFER_HEIGHT = 1200;
export const PORTRAIT_WIDTH = 1200;
export const PORTRAIT_HEIGHT = 1600;

export type DitherAlgorithm = "floyd_steinberg" | "atkinson" | "ordered";
export const DITHER_ALGORITHMS: DitherAlgorithm[] = ["floyd_steinberg", "atkinson", "ordered"];

// Packed-blob compression (see root CLAUDE.md's "Encrypted Image Buckets" ->
// packed-blob compression plan). "identity" is the plain packed 4bpp buffer;
// "deflate-raw" is that buffer run through CompressionStream('deflate-raw')
// client-side, before AES-256-GCM encryption - see client/compress.ts.
export type PackedEncoding = "identity" | "deflate-raw";
export const PACKED_ENCODINGS: PackedEncoding[] = ["identity", "deflate-raw"];

/** Shared by every route that accepts a client-reported packed_encoding field
 *  (admin/images.ts's upload, admin/buckets.ts's reencrypt-image) - kept here
 *  rather than duplicated per-route, same reasoning as DITHER_ALGORITHMS. */
export function isValidPackedEncoding(value: string): value is PackedEncoding {
  return (PACKED_ENCODINGS as string[]).includes(value);
}
