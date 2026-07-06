import { describe, expect, it } from "vitest";
import { ditherImage, packToNibbles, quantizeWithResidual } from "../../src/lib/dither";
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
