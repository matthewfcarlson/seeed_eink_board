/** The Spectra 6 hardware palette + nibble codes — must match firmware exactly
 *  (image_server.py's PALETTE_RGB / HARDWARE_MAP). 0x4 is intentionally unused. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const PALETTE: Rgb[] = [
  { r: 0, g: 0, b: 0 }, // 0: Black
  { r: 255, g: 255, b: 255 }, // 1: White
  { r: 255, g: 255, b: 0 }, // 2: Yellow
  { r: 255, g: 0, b: 0 }, // 3: Red
  { r: 0, g: 0, b: 255 }, // 4: Blue
  { r: 41, g: 204, b: 20 }, // 5: Green
];

/**
 * What each PALETTE entry actually looks like on a Spectra 6 panel under
 * ordinary indoor light, index-aligned with PALETTE. Used only by the
 * dashboard's display preview (client/display-preview.ts) to show how a
 * dithered image will read on the wall: the panel's "white" is a light gray
 * paper, its black isn't fully black, and its inks are far less saturated
 * than pure RGB. Dithering itself still targets PALETTE.
 *
 * APPROXIMATE: eyeballed from published photos of Spectra 6 panels, not
 * measured on our hardware. To calibrate, photograph a panel showing six
 * solid swatches next to a gray card under neutral light, white-balance on
 * the card, and sample the swatch centers.
 */
export const PANEL_APPEARANCE: Rgb[] = [
  { r: 38, g: 38, b: 44 }, // 0: Black
  { r: 190, g: 190, b: 182 }, // 1: White
  { r: 196, g: 182, b: 40 }, // 2: Yellow
  { r: 152, g: 38, b: 32 }, // 3: Red
  { r: 40, g: 64, b: 142 }, // 4: Blue
  { r: 60, g: 100, b: 66 }, // 5: Green
];

/** palette index -> hardware nibble. 0x4 skipped, matches firmware's display controller. */
export const NIBBLE_MAP = [0x0, 0x1, 0x2, 0x3, 0x5, 0x6];

export function nearestPaletteIndex(r: number, g: number, b: number): number {
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const p = PALETTE[i]!;
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  return bestIndex;
}
