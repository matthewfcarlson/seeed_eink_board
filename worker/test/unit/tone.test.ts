import { describe, expect, it } from "vitest";
import { analyzeTone, buildToneLut, prepareForPanel } from "../../src/lib/tone";
import { PANEL_MATCHER, makeOklabMatcher, ditherImage } from "../../src/lib/dither";
import { PANEL_APPEARANCE } from "../../src/lib/palette";

/** Histogram of `count` pixels spread evenly over luma values lo..hi. */
function flatHistogram(lo: number, hi: number, count = 25600): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < count; i++) h[lo + Math.floor((i * (hi - lo + 1)) / count)]!++;
  return h;
}

describe("analyzeTone / buildToneLut", () => {
  it("leaves a full-range, well-exposed photo nearly alone: no stretch, no S-curve, only the slight brighten", () => {
    const t = analyzeTone(flatHistogram(0, 255));
    expect(t.blackPoint).toBeLessThanOrEqual(2);
    expect(t.whitePoint).toBeGreaterThanOrEqual(253);
    expect(t.sCurve).toBe(0);
    expect(t.gamma).toBeCloseTo(1.08, 2);
  });

  it("stretches a washed-out photo, but never more than the clip limit", () => {
    const t = analyzeTone(flatHistogram(90, 170));
    expect(t.blackPoint).toBe(44);
    expect(t.whitePoint).toBe(211);
  });

  it("brightens a dark photo more than a bright one", () => {
    const dark = analyzeTone(flatHistogram(0, 120));
    const bright = analyzeTone(flatHistogram(100, 255));
    expect(dark.gamma).toBeGreaterThan(bright.gamma);
    const darkLut = buildToneLut(dark);
    expect(darkLut[60]!).toBeGreaterThan(60);
  });

  it("adds contrast only to a flat photo", () => {
    expect(analyzeTone(flatHistogram(100, 150)).sCurve).toBeGreaterThan(0);
    expect(analyzeTone(flatHistogram(0, 255)).sCurve).toBe(0);
  });

  it("always builds a monotonic curve from 0 to 255", () => {
    for (const h of [flatHistogram(0, 255), flatHistogram(100, 150), flatHistogram(0, 60), flatHistogram(200, 255)]) {
      const lut = buildToneLut(analyzeTone(h));
      expect(lut[0]).toBe(0);
      expect(lut[255]).toBe(255);
      for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
    }
  });
});

describe("prepareForPanel", () => {
  it("maps pure white to panel white and pure black to panel black", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    prepareForPanel(rgba, 2, 1, PANEL_APPEARANCE[0]!, PANEL_APPEARANCE[1]!);
    const white = PANEL_APPEARANCE[1]!;
    const black = PANEL_APPEARANCE[0]!;
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([white.r, white.g, white.b, 255]);
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([black.r, black.g, black.b, 255]);
  });
});

describe("PANEL_MATCHER", () => {
  it("returns each measured ink as its own nearest color", () => {
    PANEL_APPEARANCE.forEach((c, i) => expect(PANEL_MATCHER.nearest(c.r, c.g, c.b)).toBe(i));
  });

  it("judges by perception: a dark brick red matches the measured red, not black", () => {
    const red = PANEL_APPEARANCE[3]!;
    expect(makeOklabMatcher(PANEL_APPEARANCE).nearest(red.r + 8, red.g + 4, red.b + 4)).toBe(3);
  });

  /** Dithers a flat w*h patch of one color and returns the indices. */
  function ditherPatch(r: number, g: number, b: number, w = 48, h = 48): Uint8Array {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
    return ditherImage(rgba, w, h, "floyd_steinberg", PANEL_MATCHER);
  }

  it("preserves a flat color's average (error diffusion sums back to the input)", () => {
    const black = PANEL_APPEARANCE[0]!;
    const white = PANEL_APPEARANCE[1]!;
    const gray = [(black.r + white.r) / 2, (black.g + white.g) / 2, (black.b + white.b) / 2];
    const indices = ditherPatch(gray[0]!, gray[1]!, gray[2]!);
    const avg = [0, 0, 0];
    for (const i of indices) {
      const c = PANEL_APPEARANCE[i]!;
      avg[0]! += c.r / indices.length;
      avg[1]! += c.g / indices.length;
      avg[2]! += c.b / indices.length;
    }
    for (let ch = 0; ch < 3; ch++) expect(Math.abs(avg[ch]! - gray[ch]!)).toBeLessThan(8);
  });

  it("keeps a bright red mostly red ink rather than drifting to yellow", () => {
    // A photo's bright red after prepareForPanel's mapping into panel range.
    const rgba = new Uint8ClampedArray([220, 40, 40, 255]);
    prepareForPanel(rgba, 1, 1, PANEL_APPEARANCE[0]!, PANEL_APPEARANCE[1]!);
    const indices = ditherPatch(rgba[0]!, rgba[1]!, rgba[2]!);
    const counts = new Array(PANEL_APPEARANCE.length).fill(0);
    for (const i of indices) counts[i]++;
    expect(counts[3]).toBeGreaterThan(counts[2]); // red > yellow
    expect(counts.indexOf(Math.max(...counts))).toBe(3);
  });
});
