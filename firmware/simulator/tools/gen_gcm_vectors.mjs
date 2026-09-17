#!/usr/bin/env node
// Generates real-crypto AES-256-GCM test vectors for test_gcm_stream.cpp -
// ground truth from Node's actual `crypto.subtle`, not a reimplementation of
// mbedtls. See that file's header comment for why this cross-check matters.
//
// Writes into tools/gcm_vectors/ (gitignored - regenerate freely):
//   key.bin              - 32 random bytes, the shared AES-256 key
//   gvecN.plain.bin       - vector N's plaintext
//   gvecN.blob.bin        - nonce(12) || ciphertext || tag(16), real WebCrypto output
//
// Run: node tools/gen_gcm_vectors.mjs

import { webcrypto, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { subtle } = webcrypto;
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "gcm_vectors");
mkdirSync(outDir, { recursive: true });

// Sizes chosen to straddle test_gcm_stream.cpp's own chunk sizes
// (0/1/3/15/16/17/64/512/65536): empty, sub-chunk, exactly one 512-chunk,
// spanning several chunks, and spanning several 65536-byte chunks.
const VECTOR_SIZES = [0, 1, 17, 1000, 200_000];

const keyBytes = randomBytes(32);
writeFileSync(path.join(outDir, "key.bin"), keyBytes);
const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);

for (let i = 0; i < VECTOR_SIZES.length; i++) {
  const plain = VECTOR_SIZES[i] === 0 ? Buffer.alloc(0) : randomBytes(VECTOR_SIZES[i]);
  const nonce = randomBytes(12);
  // WebCrypto's AES-GCM encrypt() output is ciphertext with the 16-byte tag
  // already appended - exactly the nonce||ciphertext||tag shape a device
  // receives as an /image_packed response body.
  const ciphertextAndTag = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const blob = Buffer.concat([nonce, ciphertextAndTag]);

  writeFileSync(path.join(outDir, `gvec${i}.plain.bin`), plain);
  writeFileSync(path.join(outDir, `gvec${i}.blob.bin`), blob);
  console.log(`gvec${i}: plain=${plain.length} blob=${blob.length}`);
}

console.log(`wrote ${VECTOR_SIZES.length} vectors + key.bin to ${outDir}`);
