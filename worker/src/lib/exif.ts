/**
 * Reads the EXIF Orientation tag (1-8) from JPEG bytes. Returns 1 (no-op) for
 * non-JPEG input or when EXIF/orientation can't be found — mirrors the safe
 * fallback behavior of PIL's ImageOps.exif_transpose() in the Python pipeline.
 * Photon's decoder does not apply EXIF orientation itself, so this must run
 * before resize/crop or portrait/landscape photos from phones will come out
 * sideways/upside down.
 */
export function readJpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;

    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break; // Start of Scan: no more metadata markers follow

    const segmentLength = view.getUint16(offset + 2, false);

    if (marker === 0xe1) {
      const sigOffset = offset + 4;
      const isExif =
        bytes[sigOffset] === 0x45 &&
        bytes[sigOffset + 1] === 0x78 &&
        bytes[sigOffset + 2] === 0x69 &&
        bytes[sigOffset + 3] === 0x66 &&
        bytes[sigOffset + 4] === 0x00 &&
        bytes[sigOffset + 5] === 0x00;
      if (isExif) {
        const orientation = parseTiffOrientation(view, sigOffset + 6);
        if (orientation) return orientation;
      }
    }

    offset += 2 + segmentLength;
  }

  return 1;
}

function parseTiffOrientation(view: DataView, tiffStart: number): number | null {
  if (tiffStart + 8 > view.byteLength) return null;

  const byteOrder = view.getUint16(tiffStart, false);
  const little = byteOrder === 0x4949;
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;

  const ifdOffset = view.getUint32(tiffStart + 4, little);
  const entriesOffset = tiffStart + ifdOffset;
  if (entriesOffset + 2 > view.byteLength) return null;

  const numEntries = view.getUint16(entriesOffset, little);
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = entriesOffset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, little);
    if (tag === 0x0112) {
      return view.getUint16(entryOffset + 8, little);
    }
  }
  return null;
}

/** Applies an EXIF orientation (2-8) to an RGBA buffer. Orientation 1 is a no-op. */
export function applyOrientation(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  orientation: number
): { rgba: Uint8ClampedArray; width: number; height: number } {
  if (orientation === 1) return { rgba, width, height };

  const swapsDims = orientation >= 5;
  const outW = swapsDims ? height : width;
  const outH = swapsDims ? width : height;
  const out = new Uint8ClampedArray(rgba.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2:
          dx = width - 1 - x;
          dy = y;
          break;
        case 3:
          dx = width - 1 - x;
          dy = height - 1 - y;
          break;
        case 4:
          dx = x;
          dy = height - 1 - y;
          break;
        case 5:
          dx = y;
          dy = x;
          break;
        case 6:
          dx = height - 1 - y;
          dy = x;
          break;
        case 7:
          dx = height - 1 - y;
          dy = width - 1 - x;
          break;
        case 8:
          dx = y;
          dy = width - 1 - x;
          break;
        default:
          dx = x;
          dy = y;
      }
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
