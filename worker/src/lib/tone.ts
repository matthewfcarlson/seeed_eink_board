import type { Rgb } from "./palette";

/**
 * The tone half of the image pipeline (IMAGE_PIPELINE_VERSION 3+), run on
 * the board-oriented RGBA buffer before dithering — see dither.ts's
 * enhanceAndDither(). Replaces the old fixed "contrast 1.2 around the
 * image's mean" step, which pushed most photos' shadows toward black. Each
 * adjustment here is driven by the photo itself:
 *
 *  1. Levels: stretch the luma range to full scale, but only as far as the
 *     photo needs it — a photo already spanning ~0-255 is left alone, and
 *     the gain is capped so a nearly flat image isn't blown out.
 *  2. Brighten: a gamma lift that always brightens slightly and pulls a
 *     dark photo's median partway toward mid-gray.
 *  3. Contrast: a gentle S-curve, only for photos whose luma spread is low.
 *
 * All three are the same curve for every channel, so they're baked into one
 * 256-entry LUT (hue-preserving, cheap). Saturation then gets a mild boost,
 * and finally every channel is mapped linearly into the panel's own range
 * (PANEL_APPEARANCE black..white), so photo-white lands exactly on panel
 * paper-white and the ditherer, which targets the measured inks, never
 * chases brightness the panel can't produce.
 */

// Levels: percentiles of luma that define the photo's black/white points.
const LEVELS_LOW_PERCENTILE = 0.005;
const LEVELS_HIGH_PERCENTILE = 0.995;
// Never move the black point above this or the white point below
// 255 - this, i.e. at most a ~1.5x stretch.
const LEVELS_MAX_CLIP = 44;

// Brighten: always at least this gamma (>1 brightens), and pull the median
// this fraction of the way toward MID_GRAY, up to MAX_GAMMA.
const MIN_GAMMA = 1.08;
const MAX_GAMMA = 1.6;
const MID_GRAY = 0.5;
const MEDIAN_PULL = 0.5;

// Contrast: S-curve strength ramps from 0 at FLAT_STD_HIGH luma standard
// deviation (normalized 0-1) up to MAX_S_CURVE at FLAT_STD_LOW and below.
const FLAT_STD_HIGH = 0.2;
const FLAT_STD_LOW = 0.1;
const MAX_S_CURVE = 0.4;

export const TONE_SATURATION = 1.2;

export interface ToneAnalysis {
  blackPoint: number;
  whitePoint: number;
  gamma: number;
  sCurve: number;
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function percentile(histogram: Uint32Array, total: number, fraction: number): number {
  const target = total * fraction;
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i]!;
    if (seen > target) return i;
  }
  return histogram.length - 1;
}

/** Decides the levels/gamma/S-curve for one photo from its luma histogram (256 bins). */
export function analyzeTone(histogram: Uint32Array): ToneAnalysis {
  let total = 0;
  for (let i = 0; i < 256; i++) total += histogram[i]!;
  if (total === 0) return { blackPoint: 0, whitePoint: 255, gamma: MIN_GAMMA, sCurve: 0 };

  const low = percentile(histogram, total, LEVELS_LOW_PERCENTILE);
  const high = percentile(histogram, total, LEVELS_HIGH_PERCENTILE);
  const blackPoint = Math.min(low, LEVELS_MAX_CLIP);
  const whitePoint = Math.max(high, 255 - LEVELS_MAX_CLIP, blackPoint + 1);
  const levels = (v: number) => clamp((v - blackPoint) / (whitePoint - blackPoint), 0, 1);

  // Median and spread of the photo AFTER levels, which is what the later
  // steps actually see.
  const median = levels(percentile(histogram, total, 0.5));
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < 256; i++) {
    const v = levels(i);
    sum += v * histogram[i]!;
    sumSq += v * v * histogram[i]!;
  }
  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sumSq / total - mean * mean));

  // gamma so that median^(1/gamma) lands MEDIAN_PULL of the way to MID_GRAY.
  const target = median + (MID_GRAY - median) * MEDIAN_PULL;
  const wanted = median > 0 && median < 1 && target > 0 && target < 1 ? Math.log(median) / Math.log(target) : MIN_GAMMA;
  const gamma = clamp(wanted, MIN_GAMMA, MAX_GAMMA);

  const sCurve = clamp((FLAT_STD_HIGH - std) / (FLAT_STD_HIGH - FLAT_STD_LOW), 0, 1) * MAX_S_CURVE;
  return { blackPoint, whitePoint, gamma, sCurve };
}

/** The 256-entry per-channel curve for an analysis: levels, then gamma, then S-curve. */
export function buildToneLut(t: ToneAnalysis): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = clamp((i - t.blackPoint) / (t.whitePoint - t.blackPoint), 0, 1);
    v = Math.pow(v, 1 / t.gamma);
    const smooth = v * v * (3 - 2 * v);
    v = v + (smooth - v) * t.sCurve;
    lut[i] = Math.round(v * 255);
  }
  return lut;
}

/**
 * Applies the whole tone stage in place (alpha untouched): tone LUT,
 * saturation, then the linear map of each channel into
 * [panelBlack, panelWhite].
 */
export function prepareForPanel(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  panelBlack: Rgb,
  panelWhite: Rgb
): ToneAnalysis {
  const pixelCount = width * height;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    histogram[Math.round(luma(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!))]!++;
  }
  const analysis = analyzeTone(histogram);
  const lut = buildToneLut(analysis);

  const scaleR = (panelWhite.r - panelBlack.r) / 255;
  const scaleG = (panelWhite.g - panelBlack.g) / 255;
  const scaleB = (panelWhite.b - panelBlack.b) / 255;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    let r = lut[rgba[o]!]!;
    let g = lut[rgba[o + 1]!]!;
    let b = lut[rgba[o + 2]!]!;
    // Saturation: blend away from (or toward) this pixel's own luma.
    const l = luma(r, g, b);
    r = clamp(l + (r - l) * TONE_SATURATION, 0, 255);
    g = clamp(l + (g - l) * TONE_SATURATION, 0, 255);
    b = clamp(l + (b - l) * TONE_SATURATION, 0, 255);
    rgba[o] = panelBlack.r + r * scaleR;
    rgba[o + 1] = panelBlack.g + g * scaleG;
    rgba[o + 2] = panelBlack.b + b * scaleB;
  }
  return analysis;
}
