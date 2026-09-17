#!/usr/bin/env node
// Generates end-to-end fixtures for test_decrypt_inflate_pipeline.cpp - the
// full pack -> compress(deflate-raw) -> encrypt(AES-256-GCM) pipeline a real
// device response goes through, built entirely from independent ground
// truth (Node's own zlib + crypto.subtle), so a bug in the real
// decryptChunksInflate() pipeline (not just in this test's model of it) gets
// caught. See test_decrypt_inflate_pipeline.cpp's header comment.
//
// Writes into tools/combined_vectors/ (gitignored - regenerate freely):
//   key.bin                        - 32 random bytes, the AES-256 bucket key
//   packed_plain.bin                - the packed 4bpp buffer BEFORE compression -
//                                      what decryptChunksInflate() must recover exactly
//   response_blob.bin               - nonce(12) || deflateRawSync(packed_plain) [AES-256-GCM] || tag(16),
//                                      i.e. exactly what a device receives as an
//                                      /image_packed response body
//   response_blob_corrupted.bin     - same, with one ciphertext byte flipped -
//                                      must be rejected (tag never verifies)
//
// Run: node tools/gen_combined_vectors.mjs

import { webcrypto, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { subtle } = webcrypto;
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "combined_vectors");
mkdirSync(outDir, { recursive: true });

// firmware/src/ee02/config.h's BUFFER_SIZE: (1600 * 1200) / 2 bytes at 4bpp.
const EE02_WIDTH = 1600;
const EE02_HEIGHT = 1200;
const BUFFER_SIZE = (EE02_WIDTH * EE02_HEIGHT) / 2;

// worker/src/lib/palette.ts's NIBBLE_MAP: palette index -> hardware nibble
// (0x4 intentionally skipped). Reimplemented here (not imported) so this
// fixture generator has no dependency on worker/ - see packToNibbles() below.
const NIBBLE_MAP = [0x0, 0x1, 0x2, 0x3, 0x5, 0x6];

/** Mirrors worker/src/lib/dither.ts's packToNibbles(): two palette indices
 *  (0-5) per output byte, high nibble first. */
function packToNibbles(indices) {
  const packed = Buffer.alloc(Math.ceil(indices.length / 2));
  for (let i = 0; i < indices.length; i += 2) {
    const v1 = NIBBLE_MAP[indices[i]] ?? 0x1;
    const v2 = i + 1 < indices.length ? NIBBLE_MAP[indices[i + 1]] ?? 0x1 : 0x1;
    packed[i / 2] = (v1 << 4) | v2;
  }
  return packed;
}

// A realistic dithered-image-shaped source: top half solid black (index 0),
// bottom half solid red (index 3) - same recognizable pattern
// worker/test/e2e/lib/test-image.ts's buildTestPackedImage() uses, so a
// visual diff of a real failure here looks the same way it would in the e2e
// simulator run.
const pixelIndices = new Uint8Array(EE02_WIDTH * EE02_HEIGHT);
for (let row = 0; row < EE02_HEIGHT; row++) {
  const index = row < EE02_HEIGHT / 2 ? 0 : 3; // black top, red bottom
  pixelIndices.fill(index, row * EE02_WIDTH, (row + 1) * EE02_WIDTH);
}
const packedPlain = packToNibbles(pixelIndices);
if (packedPlain.length !== BUFFER_SIZE) {
  throw new Error(`packed buffer is ${packedPlain.length} bytes, expected BUFFER_SIZE=${BUFFER_SIZE}`);
}

const compressed = deflateRawSync(packedPlain);

const keyBytes = randomBytes(32);
const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
const nonce = randomBytes(12);
const ciphertextAndTag = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, compressed));
const responseBlob = Buffer.concat([nonce, ciphertextAndTag]);

// Corrupt one byte inside the ciphertext region (never the nonce, and never
// far enough in to land in the trailing 16-byte tag) so GCM's own integrity
// check - not just a length/shape check - is what has to catch this.
const corrupted = Buffer.from(responseBlob);
const ciphertextStart = 12;
const ciphertextEnd = responseBlob.length - 16;
const flipOffset = ciphertextStart + Math.floor((ciphertextEnd - ciphertextStart) / 2);
corrupted[flipOffset] ^= 0xff;

writeFileSync(path.join(outDir, "key.bin"), keyBytes);
writeFileSync(path.join(outDir, "packed_plain.bin"), packedPlain);
writeFileSync(path.join(outDir, "response_blob.bin"), responseBlob);
writeFileSync(path.join(outDir, "response_blob_corrupted.bin"), corrupted);

console.log(
  `packed_plain=${packedPlain.length} compressed=${compressed.length} response_blob=${responseBlob.length}`
);
console.log(`wrote fixtures to ${outDir}`);
