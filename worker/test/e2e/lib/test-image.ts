import { createHash } from "node:crypto";

// EE02: 1600x1200 4bpp (2 px/byte) - see root CLAUDE.md's "Display Hardware
// Details". Row-major, no per-row padding (verified against
// firmware/simulator/display_render.cpp's present(), which is what actually
// renders the exported JPEG this suite decodes).
const EE02_WIDTH = 1600;
const EE02_HEIGHT = 1200;
export const EE02_PACKED_BYTES = (EE02_WIDTH * EE02_HEIGHT) / 2;

const BLACK_NIBBLE = 0x0;
const RED_NIBBLE = 0x3;

/** A plaintext EE02 packed buffer that's solid black on top, solid red on the
 *  bottom half - two easily-distinguished bands so the e2e test can decode
 *  the simulator's exported JPEG and confirm the *actual pixels* the device
 *  displayed came from this specific image, not just that some request
 *  succeeded. */
export function buildTestPackedImage(): { packed: Uint8Array; packedHash: string } {
  const packed = new Uint8Array(EE02_PACKED_BYTES);
  const halfwayByte = (EE02_WIDTH / 2) * (EE02_HEIGHT / 2);
  packed.fill(BLACK_NIBBLE << 4 | BLACK_NIBBLE, 0, halfwayByte);
  packed.fill((RED_NIBBLE << 4) | RED_NIBBLE, halfwayByte);

  // Opaque change-detection metadata as far as the Worker is concerned (see
  // admin/images.ts's doc comment) - any stable 16-char hex string works.
  const packedHash = createHash("sha256").update(packed).digest("hex").slice(0, 16);
  return { packed, packedHash };
}

/** Content doesn't matter for raw/thumb - nothing in this suite's flow
 *  (device fetch/display) ever reads them back; only /admin/images/upload's
 *  "non-empty" check applies (see lib/image-upload.ts). */
export function buildDummyBlob(label: string): Uint8Array {
  return new TextEncoder().encode(`e2e-test-${label}`);
}

export { EE02_HEIGHT };
