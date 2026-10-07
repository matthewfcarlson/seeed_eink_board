import { describe, expect, it } from "vitest";
import { paintPanelAppearance } from "../../src/client/display-preview";
import { rotate90CW } from "../../src/lib/decode";
import { PALETTE, PANEL_APPEARANCE } from "../../src/lib/palette";

describe("paintPanelAppearance", () => {
  it("has one panel-appearance color per palette entry", () => {
    expect(PANEL_APPEARANCE).toHaveLength(PALETTE.length);
  });

  it("undoes rotate90CW, returning palette indices to their upright positions", () => {
    const w = 5;
    const h = 3;
    // Upright index grid, smuggled through rotate90CW in the red channel.
    const upright = Array.from({ length: w * h }, (_, i) => i % PALETTE.length);
    const rgba = new Uint8ClampedArray(w * h * 4);
    upright.forEach((v, i) => (rgba[i * 4] = v));
    const rotated = rotate90CW(rgba, w, h);
    const boardIndices = new Uint8Array(rotated.width * rotated.height);
    for (let i = 0; i < boardIndices.length; i++) boardIndices[i] = rotated.rgba[i * 4]!;

    const out = paintPanelAppearance(boardIndices, rotated.width, w, h, true);
    for (let i = 0; i < w * h; i++) {
      const expected = PANEL_APPEARANCE[upright[i]!]!;
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]]).toEqual([expected.r, expected.g, expected.b, 255]);
    }
  });

  it("maps an unrotated buffer straight through", () => {
    const indices = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const out = paintPanelAppearance(indices, 3, 3, 2, false);
    expect([out[4 * 4], out[4 * 4 + 1], out[4 * 4 + 2]]).toEqual([PANEL_APPEARANCE[4]!.r, PANEL_APPEARANCE[4]!.g, PANEL_APPEARANCE[4]!.b]);
  });
});
