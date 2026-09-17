#!/usr/bin/env node
// Generates real `zlib.deflateRawSync()` test vectors for test_tinfl_stream.cpp
// - ground truth from Node's actual zlib, not a reimplementation of DEFLATE.
// See that file's header comment for what each vector is chosen to stress.
//
// Writes into tools/vectors/ (gitignored - regenerate freely):
//   vecN.plain.bin     - vector N's original plaintext
//   vecN.deflate.bin   - Node's real deflateRawSync() of that plaintext
//
// Run: node tools/gen_tinfl_vectors.mjs

import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors");
mkdirSync(outDir, { recursive: true });

// EE02's real packed-4bpp buffer size (firmware/src/ee02/config.h's BUFFER_SIZE) -
// used for vector 8's near-worst-case-for-memory input.
const EE02_BUFFER_SIZE = 960_000;

/** A packed-4bpp-shaped buffer: two palette-nibble values per byte, matching
 *  worker/src/lib/palette.ts's NIBBLE_MAP (0x0,0x1,0x2,0x3,0x5,0x6) - mostly
 *  one flat color with a scattered "dithered" minority, the shape that
 *  actually reaches the device, rather than uniform random noise. */
function packedImageShaped(length, flatNibble, noiseFraction) {
  const buf = Buffer.alloc(length, (flatNibble << 4) | flatNibble);
  const noiseValues = [0x0, 0x1, 0x2, 0x3, 0x5, 0x6];
  const noiseBytes = Math.floor(length * noiseFraction);
  for (let i = 0; i < noiseBytes; i++) {
    const offset = Math.floor(Math.random() * length);
    const hi = noiseValues[Math.floor(Math.random() * noiseValues.length)];
    const lo = noiseValues[Math.floor(Math.random() * noiseValues.length)];
    buf[offset] = (hi << 4) | lo;
  }
  return buf;
}

function repetitivePattern(length, pattern) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = pattern[i % pattern.length];
  return buf;
}

// Indices must match test_tinfl_stream.cpp's kNumVectors=9 and vecN naming.
const VECTORS = [
  /* 0 */ Buffer.alloc(0), // empty input
  /* 1 */ Buffer.from("Hello!"), // tiny input
  /* 2 */ repetitivePattern(20_000, [0xaa]), // highly repetitive, pattern A
  /* 3 */ repetitivePattern(20_000, [0x00, 0x01, 0x02, 0x03]), // highly repetitive, pattern B
  /* 4 */ randomBytes(20_000), // incompressible/random
  /* 5 */ packedImageShaped(50_000, 0x1, 0.02), // realistic packed-4bpp-dithered-image-shaped
  /* 6 */ randomBytes(1), // single byte
  /* 7 */ randomBytes(16), // exact AES-block-size (16 byte) input
  /* 8 */ packedImageShaped(EE02_BUFFER_SIZE, 0x1, 0.001), // near-worst-case-for-memory, mostly flat
];

for (let i = 0; i < VECTORS.length; i++) {
  const plain = VECTORS[i];
  const compressed = deflateRawSync(plain);
  writeFileSync(path.join(outDir, `vec${i}.plain.bin`), plain);
  writeFileSync(path.join(outDir, `vec${i}.deflate.bin`), compressed);
  console.log(`vec${i}: plain=${plain.length} deflate=${compressed.length}`);
}

console.log(`wrote ${VECTORS.length} vectors to ${outDir}`);
