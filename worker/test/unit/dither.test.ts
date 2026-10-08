import { describe, expect, it } from "vitest";
import { DIFFUSION_KERNELS, IDEAL_RGB_MATCHER, PANEL_MATCHER, PIPELINE_DITHER, ditherImage, errorDiffuse, packToNibbles, quantizeWithResidual } from "../../src/lib/dither";
import { NIBBLE_MAP, PALETTE } from "../../src/lib/palette";

/**
 * Regression test for a real bug: error-diffusion dithering (Floyd-Steinberg,
 * Atkinson) computed the residual error from the UNCLAMPED accumulator value
 * instead of the clamped one used for the palette lookup. Once accumulated
 * error pushed a working value outside 0-255 (which happens routinely — the
 * "work" buffer is a Float32Array that keeps absorbing diffused error, not
 * re-clamped between pixels), the residual could be arbitrarily large,
 * causing error to explode and propagate across neighbors. Visually this
 * showed up as structured ghosting/shearing on large flat-color regions in a
 * real test photo — this test instead pins down the root cause directly and
 * deterministically, rather than trying to statistically reproduce the
 * emergent visual symptom (which turned out to need a fairly specific
 * combination of image size/geometry/colors to manifest at all).
 */
describe("quantizeWithResidual: residual is always computed from the clamped value", () => {
  it("returns a bounded residual even when the input is far outside 0-255", () => {
    // Simulate a work[] value that has drifted from accumulated diffused error —
    // exactly the scenario the bug mishandled.
    const result = quantizeWithResidual(600, -300, 900);

    expect(Math.abs(result.dr)).toBeLessThanOrEqual(255);
    expect(Math.abs(result.dg)).toBeLessThanOrEqual(255);
    expect(Math.abs(result.db)).toBeLessThanOrEqual(255);
  });

  it("picks the same palette index whether inputs are already in range or clamp down/up to it", () => {
    // 300 clamps to 255, -50 clamps to 0 — same effective color either way.
    const inRange = quantizeWithResidual(255, 0, 0);
    const outOfRange = quantizeWithResidual(300, -50, -20);
    expect(outOfRange.index).toBe(inRange.index);
    expect(outOfRange.dr).toBe(inRange.dr);
    expect(outOfRange.dg).toBe(inRange.dg);
    expect(outOfRange.db).toBe(inRange.db);
  });

  it("residual is exactly zero when the (clamped) input is already an exact palette color", () => {
    for (const p of PALETTE) {
      const result = quantizeWithResidual(p.r, p.g, p.b);
      expect(result.dr).toBe(0);
      expect(result.dg).toBe(0);
      expect(result.db).toBe(0);
    }
  });
});

describe("dither: packToNibbles output only ever uses the defined hardware nibble values", () => {
  it("stays within the valid nibble set for a flat color", () => {
    const width = 40;
    const height = 40;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 90;
      rgba[i * 4 + 1] = 90;
      rgba[i * 4 + 2] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const indices = ditherImage(rgba, width, height, "floyd_steinberg");
    const packed = packToNibbles(indices);

    const validNibbles = new Set(NIBBLE_MAP);
    for (const byte of packed) {
      expect(validNibbles.has((byte >> 4) & 0xf)).toBe(true);
      expect(validNibbles.has(byte & 0xf)).toBe(true);
    }
    expect(PALETTE.length).toBe(6);
  });
});

describe("errorDiffuse (pipeline dithering)", () => {
  function flat(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
    return rgba;
  }

  it("matches the classic ditherImage('floyd_steinberg') when not serpentine and at full strength", () => {
    const a = ditherImage(flat(40, 30, 130, 90, 60), 40, 30, "floyd_steinberg");
    const b = errorDiffuse(flat(40, 30, 130, 90, 60), 40, 30, IDEAL_RGB_MATCHER, {
      kernel: DIFFUSION_KERNELS.floydSteinberg,
      serpentine: false,
      strength: 1,
    });
    expect(b).toEqual(a);
  });

  it("serpentine scanning changes the pattern (rows alternate direction)", () => {
    const opts = { kernel: DIFFUSION_KERNELS.floydSteinberg, strength: 1 };
    const oneWay = errorDiffuse(flat(40, 30, 130, 90, 60), 40, 30, IDEAL_RGB_MATCHER, { ...opts, serpentine: false });
    const serp = errorDiffuse(flat(40, 30, 130, 90, 60), 40, 30, IDEAL_RGB_MATCHER, { ...opts, serpentine: true });
    expect(serp).not.toEqual(oneWay);
  });

  it("every kernel's weights sum to 1", () => {
    for (const kernel of Object.values(DIFFUSION_KERNELS)) {
      expect(kernel.reduce((sum, [, , w]) => sum + w, 0)).toBeCloseTo(1, 10);
    }
  });

  it("damped diffusion uses fewer off-color inks on a flat near-white area", () => {
    // Panel white nudged 10% toward the yellow ink (inside the panel's
    // range, as tone.ts guarantees): full diffusion keeps accumulating the
    // small residual into scattered off-color dots; damping lets some fade.
    const count = (strength: number) =>
      [...errorDiffuse(flat(64, 64, 186, 198, 184), 64, 64, PANEL_MATCHER, {
        kernel: DIFFUSION_KERNELS.floydSteinberg,
        serpentine: true,
        strength,
      })].filter((i) => i !== 1).length;
    expect(count(0.85)).toBeLessThan(count(1));
  });

  it("PIPELINE_DITHER is serpentine Floyd-Steinberg at 85%", () => {
    expect(PIPELINE_DITHER).toEqual({ kernel: DIFFUSION_KERNELS.floydSteinberg, serpentine: true, strength: 0.85 });
  });
});
