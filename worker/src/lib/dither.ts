import type { DitherAlgorithm } from "../types";
import { NIBBLE_MAP, PALETTE, nearestPaletteIndex } from "./palette";

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export interface QuantizeResult {
  index: number;
  dr: number;
  dg: number;
  db: number;
}

/**
 * Shared by both error-diffusion ditherers: clamp the accumulated (possibly
 * out-of-range) working value BEFORE finding the nearest palette color AND
 * before computing the residual to diffuse onward. Real bug this fixes: an
 * earlier version clamped only for the palette lookup but computed the
 * residual from the unclamped value — once accumulated error pushed a pixel
 * outside 0-255, the residual could be huge, causing error to explode and
 * propagate across neighbors (visible as structured ghosting/shearing on
 * large flat-color regions). Clamping first guarantees dr/dg/db can never
 * exceed +/-255, however far `r/g/b` have drifted.
 */
export function quantizeWithResidual(r: number, g: number, b: number): QuantizeResult {
  const cr = clamp255(r);
  const cg = clamp255(g);
  const cb = clamp255(b);
  const index = nearestPaletteIndex(cr, cg, cb);
  const p = PALETTE[index]!;
  return { index, dr: cr - p.r, dg: cg - p.g, db: cb - p.b };
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Brightness -> contrast -> saturation, same order and formulas as PIL's
 * ImageEnhance (image_server.py's process_image_to_packed). Operates in place
 * on an RGBA buffer (alpha untouched). No-ops are skipped entirely when factor
 * is exactly 1.0, matching Python's `if factor != 1.0` guards.
 */
export function enhance(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  brightness: number,
  contrast: number,
  saturation: number
): void {
  const pixelCount = width * height;

  if (brightness !== 1.0) {
    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      rgba[o] = clamp255(rgba[o]! * brightness);
      rgba[o + 1] = clamp255(rgba[o + 1]! * brightness);
      rgba[o + 2] = clamp255(rgba[o + 2]! * brightness);
    }
  }

  if (contrast !== 1.0) {
    // PIL blends toward the single mean luma of the whole (already brightness-adjusted) image.
    let sum = 0;
    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      sum += luma(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
    }
    const meanGray = sum / pixelCount;
    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      rgba[o] = clamp255(meanGray + (rgba[o]! - meanGray) * contrast);
      rgba[o + 1] = clamp255(meanGray + (rgba[o + 1]! - meanGray) * contrast);
      rgba[o + 2] = clamp255(meanGray + (rgba[o + 2]! - meanGray) * contrast);
    }
  }

  if (saturation !== 1.0) {
    // PIL blends each pixel toward its own per-pixel luma ("Color" enhancement).
    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      const l = luma(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
      rgba[o] = clamp255(l + (rgba[o]! - l) * saturation);
      rgba[o + 1] = clamp255(l + (rgba[o + 1]! - l) * saturation);
      rgba[o + 2] = clamp255(l + (rgba[o + 2]! - l) * saturation);
    }
  }
}

/** Standard Floyd-Steinberg: 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right. */
function ditherFloydSteinberg(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const work = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    work[i * 3] = rgba[p]!;
    work[i * 3 + 1] = rgba[p + 1]!;
    work[i * 3 + 2] = rgba[p + 2]!;
  }

  const indices = new Uint8Array(width * height);

  const addError = (x: number, y: number, dr: number, dg: number, db: number, weight: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 3;
    work[i] = work[i]! + dr * weight;
    work[i + 1] = work[i + 1]! + dg * weight;
    work[i + 2] = work[i + 2]! + db * weight;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const { index, dr, dg, db } = quantizeWithResidual(work[i * 3]!, work[i * 3 + 1]!, work[i * 3 + 2]!);
      indices[i] = index;

      addError(x + 1, y, dr, dg, db, 7 / 16);
      addError(x - 1, y + 1, dr, dg, db, 3 / 16);
      addError(x, y + 1, dr, dg, db, 5 / 16);
      addError(x + 1, y + 1, dr, dg, db, 1 / 16);
    }
  }

  return indices;
}

/** Atkinson: diffuses only 6/8 of the error (1/8 each to 6 neighbors), discarding the
 *  rest — produces a lighter, higher-contrast look than Floyd-Steinberg. */
function ditherAtkinson(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const work = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    work[i * 3] = rgba[p]!;
    work[i * 3 + 1] = rgba[p + 1]!;
    work[i * 3 + 2] = rgba[p + 2]!;
  }

  const indices = new Uint8Array(width * height);

  const addError = (x: number, y: number, dr: number, dg: number, db: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 3;
    work[i] = work[i]! + dr / 8;
    work[i + 1] = work[i + 1]! + dg / 8;
    work[i + 2] = work[i + 2]! + db / 8;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const { index, dr, dg, db } = quantizeWithResidual(work[i * 3]!, work[i * 3 + 1]!, work[i * 3 + 2]!);
      indices[i] = index;

      addError(x + 1, y, dr, dg, db);
      addError(x + 2, y, dr, dg, db);
      addError(x - 1, y + 1, dr, dg, db);
      addError(x, y + 1, dr, dg, db);
      addError(x + 1, y + 1, dr, dg, db);
      addError(x, y + 2, dr, dg, db);
    }
  }

  return indices;
}

// Standard 8x8 Bayer threshold matrix (values 0-63).
const BAYER_8X8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/**
 * Ordered dithering against an arbitrary palette: perturb each channel by a
 * threshold-map-derived offset before nearest-color search, no error state
 * needed (cheap, single pass). Uses a classic 8x8 Bayer matrix by default.
 *
 * NOTE: this is "ordered dithering", not true blue-noise — a real blue-noise
 * threshold texture would need to be precomputed/embedded and dropped in here
 * (the interface — a WxH threshold matrix in [0,64) — is what a blue-noise
 * tile would plug into; Bayer is the practical stand-in shipped today).
 */
function ditherOrdered(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const indices = new Uint8Array(width * height);
  const strength = 48; // +/- half-strength added per channel; tuned for a 6-color palette

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const threshold = BAYER_8X8[y % 8]![x % 8]! / 64 - 0.5; // in [-0.5, 0.5)
      const offset = threshold * strength;
      const r = clamp255(rgba[p]! + offset);
      const g = clamp255(rgba[p + 1]! + offset);
      const b = clamp255(rgba[p + 2]! + offset);
      indices[i] = nearestPaletteIndex(r, g, b);
    }
  }

  return indices;
}

export function ditherImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  algorithm: DitherAlgorithm
): Uint8Array {
  switch (algorithm) {
    case "floyd_steinberg":
      return ditherFloydSteinberg(rgba, width, height);
    case "atkinson":
      return ditherAtkinson(rgba, width, height);
    case "ordered":
      return ditherOrdered(rgba, width, height);
  }
}

/** 2 pixels/byte, big-nibble-first, using the exact hardware nibble map. */
export function packToNibbles(indices: Uint8Array): Uint8Array {
  const packed = new Uint8Array(Math.ceil(indices.length / 2));
  for (let i = 0; i < indices.length; i += 2) {
    const v1 = NIBBLE_MAP[indices[i]!] ?? 0x1;
    const v2 = i + 1 < indices.length ? (NIBBLE_MAP[indices[i + 1]!] ?? 0x1) : 0x1;
    packed[i / 2] = (v1 << 4) | v2;
  }
  return packed;
}

/** 16-hex-char content hash. SHA-256-based rather than MD5 (WebCrypto has no MD5) —
 *  contract-safe since firmware only requires a 16-char string, not a specific algorithm. */
export async function computeHash16(bytes: Uint8Array<ArrayBufferLike>): Promise<string> {
  // Normalize to a fresh ArrayBuffer-backed copy — under some type-checking
  // contexts bytes may be typed as Uint8Array<ArrayBufferLike>, which
  // crypto.subtle.digest's BufferSource type doesn't accept directly.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16);
}
