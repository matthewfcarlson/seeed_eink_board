import { DEFAULT_CROP, decodeToBoardBuffer, type CropParams } from "./decode";
import { enhanceAndDither } from "../lib/dither";
import { BOARD_GEOMETRY, type BoardId, type DitherAlgorithm } from "../lib/media-constants";
import { PANEL_APPEARANCE } from "../lib/palette";

/**
 * Simulates how a photo will look on the panel, for the upload modal's
 * "Preview on display" toggle. Runs the real pipeline (decode -> crop ->
 * rotate -> enhance -> dither, the same enhanceAndDither() the upload uses,
 * on the same board-oriented buffer, so error diffusion runs in the same
 * direction) and then paints each pixel's palette index in PANEL_APPEARANCE,
 * i.e. what that ink looks like on the panel (the same measured colors the
 * ditherer now targets) rather than the nibble's nominal pure RGB. Returned upright, at the board's full resolution — shown
 * scaled down, the browser's averaging approximates the dots blending at
 * viewing distance.
 */
export async function renderDisplayPreview(
  file: Blob,
  crop: CropParams = DEFAULT_CROP,
  board: BoardId,
  algorithm: DitherAlgorithm
): Promise<ImageData> {
  const landscape = await decodeToBoardBuffer(file, crop, board);
  const indices = enhanceAndDither(landscape.rgba, landscape.width, landscape.height, algorithm);
  const { width, height } = landscape.upright;
  const rgba = paintPanelAppearance(indices, landscape.width, width, height, BOARD_GEOMETRY[board].needsRotation);
  return new ImageData(rgba, width, height);
}

/**
 * Palette indices (board-oriented, `boardWidth` wide) -> upright RGBA in
 * panel-appearance colors. With `rotated`, undoes lib/decode.ts's rotate90CW,
 * which put upright (x, y) at board (uprightHeight - 1 - y, x).
 */
export function paintPanelAppearance(
  indices: Uint8Array,
  boardWidth: number,
  uprightWidth: number,
  uprightHeight: number,
  rotated: boolean
): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(uprightWidth * uprightHeight * 4);
  for (let y = 0; y < uprightHeight; y++) {
    for (let x = 0; x < uprightWidth; x++) {
      const index = rotated ? indices[x * boardWidth + (uprightHeight - 1 - y)]! : indices[y * boardWidth + x]!;
      const color = PANEL_APPEARANCE[index] ?? PANEL_APPEARANCE[1]!;
      const o = (y * uprightWidth + x) * 4;
      data[o] = color.r;
      data[o + 1] = color.g;
      data[o + 2] = color.b;
      data[o + 3] = 255;
    }
  }
  return data;
}
