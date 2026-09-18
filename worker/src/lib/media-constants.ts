// Split out of types.ts so client/ code (the browser-side image pipeline) can
// import these without dragging in types.ts's `Env` interface, which
// references ambient Cloudflare Workers types (D1Database/KVNamespace) that
// don't exist — and shouldn't be assumed to — in a browser TS program. Plain
// re-exported from types.ts for every existing Worker-side import.

// Every board the encrypted image pipeline knows how to pack for. Kept in
// sync with each board's firmware/src/<board>/config.h DISPLAY_WIDTH/HEIGHT
// and the same vocabulary used by devices.board/firmware_releases.board
// (see lib/github-release.ts's FIRMWARE_ASSET_NAMES).
export type BoardId = "ee02-13in3" | "ee04-7in3";

/**
 * `displayWidth`/`displayHeight`: the final packed-buffer geometry the
 * firmware expects, exactly matching that board's DISPLAY_WIDTH/HEIGHT.
 * `needsRotation`: true means the source photo is cropped to an upright
 * (portrait) `displayHeight`x`displayWidth` canvas and then rotated 90°CW —
 * both boards are mounted physically rotated and their drivers expect the
 * native landscape buffer (EE02's dual-UC8179 at 1600x1200, EE04's ED2208 at
 * 800x480) with no on-device rotation, so the server/client pipeline does
 * the rotation once, ahead of time. false would mean the board's own driver
 * does no rotation at all and the source photo is cropped directly to
 * `displayWidth`x`displayHeight` — no board currently ships mounted flat,
 * but the flag stays generic in case one does later.
 */
export interface BoardGeometry {
  displayWidth: number;
  displayHeight: number;
  needsRotation: boolean;
}

export const BOARD_GEOMETRY: Record<BoardId, BoardGeometry> = {
  "ee02-13in3": { displayWidth: 1600, displayHeight: 1200, needsRotation: true },
  "ee04-7in3": { displayWidth: 800, displayHeight: 480, needsRotation: true },
};

export const BOARD_IDS = Object.keys(BOARD_GEOMETRY) as BoardId[];

export function isValidBoardId(value: string): value is BoardId {
  return (BOARD_IDS as string[]).includes(value);
}

// The only board the image pipeline supported before per-board variants
// existed — migrations/0019_image_board_variants.sql backfills every
// pre-existing image's variant under this board id, and it's the fallback
// for a request that omits/mis-sends X-Device-Board (e.g. an old firmware
// build).
export const DEFAULT_BOARD_ID: BoardId = "ee02-13in3";

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
