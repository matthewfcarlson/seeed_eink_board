import type { DitherAlgorithm } from "./media-constants";
import { NIBBLE_MAP, PALETTE, PANEL_APPEARANCE, nearestPaletteIndex, type Rgb } from "./palette";
import { prepareForPanel } from "./tone";

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
export function quantizeWithResidual(r: number, g: number, b: number, matcher: PaletteMatcher = IDEAL_RGB_MATCHER): QuantizeResult {
  const cr = clamp255(r);
  const cg = clamp255(g);
  const cb = clamp255(b);
  const index = matcher.nearest(cr, cg, cb);
  const p = matcher.colors[index]!;
  return { index, dr: cr - p.r, dg: cg - p.g, db: cb - p.b };
}

/**
 * What the ditherers quantize against: the target color for each palette
 * index (index-aligned with PALETTE, so NIBBLE_MAP still applies) and how
 * "nearest" is judged. Error is always diffused in the same sRGB space as
 * `colors`.
 */
export interface PaletteMatcher {
  colors: Rgb[];
  /** Index of the nearest color to an in-range (0-255) r/g/b. */
  nearest(r: number, g: number, b: number): number;
}

/** Pure-RGB targets with plain RGB distance — the pre-v3 pipeline's
 *  behavior, still the default for any caller that doesn't pass a matcher. */
export const IDEAL_RGB_MATCHER: PaletteMatcher = { colors: PALETTE, nearest: nearestPaletteIndex };

// sRGB 8-bit -> linear light.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB (0-255) -> OKLab (Björn Ottosson's matrices). */
export function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = SRGB_TO_LINEAR[Math.round(r)]!;
  const lg = SRGB_TO_LINEAR[Math.round(g)]!;
  const lb = SRGB_TO_LINEAR[Math.round(b)]!;
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Nearest color judged in OKLab (perceptual), so dark and muted inks are
 *  picked the way they look rather than by raw RGB distance. `chromaWeight`
 *  scales the a/b (hue) terms against lightness: the measured red is far
 *  darker than a photo's reds, so with plain OKLab (1) bright reds match
 *  yellow-ish mixes and drift orange; weighting hue errors more keeps them
 *  red at the cost of a little lightness accuracy. */
export function makeOklabMatcher(colors: Rgb[], chromaWeight = 1): PaletteMatcher {
  const labs = colors.map((c) => srgbToOklab(c.r, c.g, c.b));
  return {
    colors,
    nearest(r, g, b) {
      const [L, A, B] = srgbToOklab(r, g, b);
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < labs.length; i++) {
        const lab = labs[i]!;
        const dL = L - lab[0];
        const dA = A - lab[1];
        const dB = B - lab[2];
        const dist = dL * dL + chromaWeight * (dA * dA + dB * dB);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    },
  };
}

// Chosen by comparing 1 and 3 on synthetic test scenes in the display
// preview: at 1 a saturated red shirt rendered orange; at 3 reds and skin
// kept their hue. Not tuned further — worth revisiting on real photos.
const PANEL_CHROMA_WEIGHT = 3;

/** The measured Spectra 6 inks (palette.ts's PANEL_APPEARANCE), matched in OKLab. */
export const PANEL_MATCHER: PaletteMatcher = makeOklabMatcher(PANEL_APPEARANCE, PANEL_CHROMA_WEIGHT);

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

/** One error-diffusion tap: offset from the current pixel (dx in scan
 *  direction) and the share of the error it receives. */
export type DiffusionTap = readonly [dx: number, dy: number, weight: number];

/** Classic kernels; each one's weights sum to 1. */
export const DIFFUSION_KERNELS = {
  floydSteinberg: [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16],
  ],
  // Stucki: 12 taps over two rows below, /42.
  stucki: [
    [1, 0, 8 / 42], [2, 0, 4 / 42],
    [-2, 1, 2 / 42], [-1, 1, 4 / 42], [0, 1, 8 / 42], [1, 1, 4 / 42], [2, 1, 2 / 42],
    [-2, 2, 1 / 42], [-1, 2, 2 / 42], [0, 2, 4 / 42], [1, 2, 2 / 42], [2, 2, 1 / 42],
  ],
  // Sierra (3-row), /32.
  sierra: [
    [1, 0, 5 / 32], [2, 0, 3 / 32],
    [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 5 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
    [-1, 2, 2 / 32], [0, 2, 3 / 32], [1, 2, 2 / 32],
  ],
} satisfies Record<string, readonly DiffusionTap[]>;

export interface ErrorDiffusionOptions {
  kernel: readonly DiffusionTap[];
  /** Alternate scan direction every row (mirroring the kernel), which breaks
   *  up the diagonal "worm" artifacts a fixed left-to-right scan leaves in
   *  smooth areas. */
  serpentine: boolean;
  /** Fraction of each pixel's error passed on (1 = classic). Below 1, flat
   *  areas get fewer lone off-color dots at a small cost in tonal accuracy. */
  strength: number;
}

/** Generic error diffusion: quantize each pixel with `matcher`, then spread
 *  `strength` x its residual over `kernel`. */
export function errorDiffuse(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  matcher: PaletteMatcher,
  options: ErrorDiffusionOptions
): Uint8Array {
  const work = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    work[i * 3] = rgba[p]!;
    work[i * 3 + 1] = rgba[p + 1]!;
    work[i * 3 + 2] = rgba[p + 2]!;
  }
  const indices = new Uint8Array(width * height);
  const { kernel, serpentine, strength } = options;
  // Flattened taps, weights pre-multiplied by strength: this loop runs once
  // per pixel per tap (~8M times for a full EE02 frame).
  const taps = kernel.length;
  const tapDx = new Int32Array(taps);
  const tapDy = new Int32Array(taps);
  const tapW = new Float32Array(taps);
  for (let t = 0; t < taps; t++) {
    tapDx[t] = kernel[t]![0];
    tapDy[t] = kernel[t]![1];
    tapW[t] = kernel[t]![2] * strength;
  }

  for (let y = 0; y < height; y++) {
    const reverse = serpentine && (y & 1) === 1;
    const dir = reverse ? -1 : 1;
    for (let step = 0; step < width; step++) {
      const x = reverse ? width - 1 - step : step;
      const i = y * width + x;
      const { index, dr, dg, db } = quantizeWithResidual(work[i * 3]!, work[i * 3 + 1]!, work[i * 3 + 2]!, matcher);
      indices[i] = index;
      for (let t = 0; t < taps; t++) {
        const nx = x + tapDx[t]! * dir;
        const ny = y + tapDy[t]!;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const w = tapW[t]!;
        const j = (ny * width + nx) * 3;
        work[j] = work[j]! + dr * w;
        work[j + 1] = work[j + 1]! + dg * w;
        work[j + 2] = work[j + 2]! + db * w;
      }
    }
  }
  return indices;
}

/** Standard Floyd-Steinberg (left-to-right, full strength) — what the
 *  "floyd_steinberg" DitherAlgorithm has always meant. */
function ditherFloydSteinberg(rgba: Uint8ClampedArray, width: number, height: number, matcher: PaletteMatcher): Uint8Array {
  return errorDiffuse(rgba, width, height, matcher, { kernel: DIFFUSION_KERNELS.floydSteinberg, serpentine: false, strength: 1 });
}

/** Atkinson: diffuses only 6/8 of the error (1/8 each to 6 neighbors), discarding the
 *  rest — produces a lighter, higher-contrast look than Floyd-Steinberg. */
function ditherAtkinson(rgba: Uint8ClampedArray, width: number, height: number, matcher: PaletteMatcher): Uint8Array {
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
      const { index, dr, dg, db } = quantizeWithResidual(work[i * 3]!, work[i * 3 + 1]!, work[i * 3 + 2]!, matcher);
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
function ditherOrdered(rgba: Uint8ClampedArray, width: number, height: number, matcher: PaletteMatcher): Uint8Array {
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
      indices[i] = matcher.nearest(r, g, b);
    }
  }

  return indices;
}

export function ditherImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  algorithm: DitherAlgorithm,
  matcher: PaletteMatcher = IDEAL_RGB_MATCHER
): Uint8Array {
  switch (algorithm) {
    case "floyd_steinberg":
      return ditherFloydSteinberg(rgba, width, height, matcher);
    case "atkinson":
      return ditherAtkinson(rgba, width, height, matcher);
    case "ordered":
      return ditherOrdered(rgba, width, height, matcher);
  }
}

/**
 * How the image pipeline dithers — fixed, not user-selectable (users used to
 * pick per upload; it's now the pipeline's call). Since
 * IMAGE_PIPELINE_VERSION 4: Floyd-Steinberg scanned serpentine, passing on
 * 85% of the error. Serpentine removes the diagonal worms of a one-way scan;
 * damping cuts the lone colored dots full diffusion scatters across flat
 * areas with only six inks (Soldered made a reduced-diffusion kernel their
 * Spectra 6 default for the same reason).
 */
export const PIPELINE_DITHER: ErrorDiffusionOptions = {
  kernel: DIFFUSION_KERNELS.floydSteinberg,
  serpentine: true,
  strength: 0.85,
};

/** What's recorded in images.dither_algorithm for new renders — closest
 *  DitherAlgorithm name to PIPELINE_DITHER. Informational only. */
export const PIPELINE_DITHER_NAME: DitherAlgorithm = "floyd_steinberg";

/**
 * The color half of the image pipeline, shared by every upload path (the
 * dashboard's upload, re-render and key rotation, its display preview, and
 * scripts/upload-images.ts). `rgba` is the board-oriented (landscape)
 * buffer and is modified: the photo-driven tone stage in tone.ts
 * (levels/brighten/contrast as needed, saturation, then fit into the
 * panel's measured black..white range), then PIPELINE_DITHER against the
 * measured inks with perceptual (OKLab) matching.
 */
export function enhanceAndDither(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  prepareForPanel(rgba, width, height, PANEL_APPEARANCE[0]!, PANEL_APPEARANCE[1]!);
  return errorDiffuse(rgba, width, height, PANEL_MATCHER, PIPELINE_DITHER);
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
