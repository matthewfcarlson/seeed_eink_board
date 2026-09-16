/**
 * Pure pixel-math helpers with no image-decoding dependency, kept server-side
 * because lib/qr-registration.ts (the synthetic "scan to register" screen, not
 * user photo content) still needs rotate90CW to lay out its buffer. Everything
 * else that used to live here — Photon-based decode/crop/resize, EXIF
 * orientation, content-type sniffing/validation — moved to client/decode.ts
 * once image upload became a client-side (browser) pipeline; see root
 * CLAUDE.md's encrypted-buckets plan. Photon is no longer a Worker dependency.
 */
export function rotate90CW(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const outW = height;
  const outH = width;
  const out = new Uint8ClampedArray(rgba.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = height - 1 - y;
      const dy = x;
      const srcOffset = (y * width + x) * 4;
      const dstOffset = (dy * outW + dx) * 4;
      out[dstOffset] = rgba[srcOffset]!;
      out[dstOffset + 1] = rgba[srcOffset + 1]!;
      out[dstOffset + 2] = rgba[srcOffset + 2]!;
      out[dstOffset + 3] = rgba[srcOffset + 3]!;
    }
  }

  return { rgba: out, width: outW, height: outH };
}
