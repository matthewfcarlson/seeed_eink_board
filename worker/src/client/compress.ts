/**
 * Client-side packed-blob compression for encrypted image buckets - see root
 * CLAUDE.md's "Encrypted Image Buckets" -> packed-blob compression plan.
 *
 * This MUST run on the plaintext packed 4bpp buffer, before crypto.ts's
 * aesGcmEncryptBlob() - AES-256-GCM ciphertext is indistinguishable from
 * random noise and doesn't compress meaningfully, so there is no point (and
 * real harm - wasted CPU) in trying to compress it afterward.
 *
 * Uses the browser-standard CompressionStream('deflate-raw') - no external
 * dependency, and raw DEFLATE (RFC 1951, no zlib/gzip header or trailer)
 * rather than the zlib-wrapped or gzip variants, since that's what a compact
 * inflate-only decoder is simplest to write against on the device (no
 * adler32/crc32 checksum to also validate - the AES-GCM tag this blob is
 * encrypted under already authenticates the compressed bytes end-to-end, so a
 * second checksum layer would be redundant). See
 * firmware/lib/common/tinfl.h/.c for the device-side inflate half.
 */

import type { PackedEncoding } from "../lib/media-constants";

/** Raw DEFLATE-compresses `bytes`. Pure function of its input - no state, no
 *  dictionary reuse between calls (each image is compressed independently). */
export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  // Fire-and-forget: the writer's own internal backpressure is handled by the
  // stream itself: we still await close() below before reading, and awaiting
  // write() (not done here) would only matter if we cared about backpressure
  // signals for a much larger/streamed input than a single in-memory Uint8Array.
  // Normalize to a fresh ArrayBuffer-backed copy - under some type-checking
  // contexts `bytes` may be typed as Uint8Array<ArrayBufferLike>, which
  // WritableStreamDefaultWriter.write()'s BufferSource type doesn't accept
  // directly (same issue dither.ts's computeHash16() works around).
  const writeDone = writer.write(new Uint8Array(bytes)).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await writeDone;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Require at least this fractional size reduction before bothering to ship
 * the compressed form - below this, the extra device-side CPU/time spent
 * inflating on every wake (battery, wake-cycle latency) isn't worth a small
 * storage/bandwidth saving. Chosen well below what real dithered packed
 * buffers actually achieve in practice (see the Step 0 measurement in this
 * feature's implementation notes: ~30-75% savings even on synthetic
 * worst-case/adversarial-noise input) - this threshold exists mainly as a
 * safety net for a genuinely incompressible pattern, not a real-world binding
 * constraint.
 */
export const PACKED_COMPRESSION_MIN_SAVINGS_FRACTION = 0.1;

export interface CompressedPacked {
  bytes: Uint8Array;
  encoding: PackedEncoding;
}

/** Compresses `packed` and returns whichever form (compressed or the
 *  original) is actually worth shipping, per
 *  PACKED_COMPRESSION_MIN_SAVINGS_FRACTION - the caller (admin.ts) encrypts
 *  and uploads whichever this returns, tagging it with `encoding` so the
 *  server (and eventually the device) know which form it is. */
export async function compressPackedForUpload(packed: Uint8Array): Promise<CompressedPacked> {
  const compressed = await deflateRaw(packed);
  const maxAcceptableBytes = packed.byteLength * (1 - PACKED_COMPRESSION_MIN_SAVINGS_FRACTION);
  if (compressed.byteLength <= maxAcceptableBytes) {
    return { bytes: compressed, encoding: "deflate-raw" };
  }
  return { bytes: packed, encoding: "identity" };
}
