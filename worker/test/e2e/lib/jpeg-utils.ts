import { readFile } from "node:fs/promises";
import jpeg from "jpeg-js";

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes/pixel. */
  data: Uint8Array;
}

export async function decodeJpeg(filePath: string): Promise<DecodedImage> {
  const bytes = await readFile(filePath);
  const { width, height, data } = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width, height, data };
}

/** Average RGB over a horizontal strip - forgiving of JPEG DCT-block
 *  artifacts near a solid-color region's edges, since our test images use
 *  color bands hundreds of pixels thick. */
export function averageColorInRow(image: DecodedImage, y: number, stripHeight = 20): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const yStart = Math.max(0, y - stripHeight / 2);
  const yEnd = Math.min(image.height, y + stripHeight / 2);
  for (let row = yStart; row < yEnd; row++) {
    for (let x = 0; x < image.width; x++) {
      const idx = (row * image.width + x) * 4;
      r += image.data[idx]!;
      g += image.data[idx + 1]!;
      b += image.data[idx + 2]!;
      count++;
    }
  }
  return { r: r / count, g: g / count, b: b / count };
}

/** display_render.cpp's nibbleToRgb() maps any unrecognized 4bpp nibble to
 *  magenta specifically so decode bugs are obvious - a real rendered frame
 *  (registration screen or a real image) should never contain it. */
export function countMagentaPixels(image: DecodedImage): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] === 255 && image.data[i + 1] === 0 && image.data[i + 2] === 255) count++;
  }
  return count;
}
