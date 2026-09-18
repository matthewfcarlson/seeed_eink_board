import { createHash } from "node:crypto";

// EE02: 1600x1200 4bpp (2 px/byte) - see root CLAUDE.md's "Display Hardware
// Details". Row-major, no per-row padding (verified against
// firmware/simulator/display_render.cpp's present(), which is what actually
// renders the exported JPEG this suite decodes).
const EE02_WIDTH = 1600;
const EE02_HEIGHT = 1200;

// EE04: 800x480 4bpp native buffer (firmware/src/ee04/display.h) - see
// lib/media-constants.ts's BoardGeometry.
const EE04_WIDTH = 800;
const EE04_HEIGHT = 480;

const BLACK_NIBBLE = 0x0;
const RED_NIBBLE = 0x3;

function packRowMajor(width: number, height: number, colorAt: (row: number, col: number) => number): Uint8Array {
  const packed = new Uint8Array((width * height) / 2);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col += 2) {
      const even = colorAt(row, col);
      const odd = colorAt(row, col + 1);
      packed[(row * width + col) / 2] = (even << 4) | odd;
    }
  }
  return packed;
}

function hashPacked(packed: Uint8Array): string {
  // Opaque change-detection metadata as far as the Worker is concerned (see
  // admin/images.ts's doc comment) - any stable 16-char hex string works.
  return createHash("sha256").update(packed).digest("hex").slice(0, 16);
}

/** A plaintext packed buffer that appears solid black on top, solid red on
 *  the bottom half ONCE DISPLAYED - two easily-distinguished bands so an e2e
 *  test can decode the simulator's exported JPEG and confirm the *actual
 *  pixels* the device displayed came from this specific image, not just that
 *  some request succeeded.
 *
 *  EE02 is mounted physically rotated (see display_render.cpp's present()
 *  and config.h's DISPLAY_MOUNTED_ROTATED) - every real content producer
 *  (worker/src/client/decode.ts, lib/qr-registration.ts) crops in portrait
 *  and rotates 90°CW before it ever reaches the wire, and present() undoes
 *  that same rotation to show what a viewer actually sees. Uploading this
 *  test image directly (bypassing that encode step) means it has to already
 *  be shaped like rotate90CW's OUTPUT: a horizontal top/bottom split in the
 *  eventual viewed (portrait) orientation lands along this buffer's COLUMN
 *  axis, not its row axis - a row-based split here would appear as a
 *  left/right split once rotated back for viewing, not top/bottom (that
 *  exact mismatch previously made this suite's pixel-content assertions
 *  fail against a genuinely-correct fetch/decrypt/display). */
export function buildTestPackedImage(): { packed: Uint8Array; packedHash: string } {
  const colThreshold = EE02_WIDTH / 2;
  const packed = packRowMajor(EE02_WIDTH, EE02_HEIGHT, (_row, col) => (col >= colThreshold ? BLACK_NIBBLE : RED_NIBBLE));
  return { packed, packedHash: hashPacked(packed) };
}

/** Same idea as buildTestPackedImage(), and for the same reason: EE04 is
 *  also mounted physically rotated now (config.h's DISPLAY_MOUNTED_ROTATED
 *  is 1, portrait only for now), so this needs the same column-based split
 *  as EE02's - a row-based split here would appear left/right once rotated
 *  back for viewing, not top/bottom. */
export function buildEe04TestPackedImage(): { packed: Uint8Array; packedHash: string } {
  const colThreshold = EE04_WIDTH / 2;
  const packed = packRowMajor(EE04_WIDTH, EE04_HEIGHT, (_row, col) => (col >= colThreshold ? BLACK_NIBBLE : RED_NIBBLE));
  return { packed, packedHash: hashPacked(packed) };
}

/** Content doesn't matter for raw/thumb - nothing in this suite's flow
 *  (device fetch/display) ever reads them back; only /admin/images/upload's
 *  "non-empty" check applies (see lib/image-upload.ts). */
export function buildDummyBlob(label: string): Uint8Array {
  return new TextEncoder().encode(`e2e-test-${label}`);
}
