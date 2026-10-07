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
 * What each PALETTE entry actually looks like on a Spectra 6 panel,
 * index-aligned with PALETTE: the panel's "white" is a light gray paper,
 * its black isn't fully black, and its inks are far darker and less
 * saturated than pure RGB. Since IMAGE_PIPELINE_VERSION 3 these are what
 * photos are dithered against (dither.ts's PANEL_MATCHER, after tone.ts fits
 * the photo into this black..white range), and the display preview
 * (client/display-preview.ts) paints them to show the result. PALETTE stays
 * the ideal-RGB set for the QR-registration screen.
 *
 * Source: the measured `spectra6` profile in epdoptimize 1.3.0
 * (https://github.com/Utzel-Butzel/epdoptimize, Apache-2.0; same values in
 * its src/dither/data/default-palettes.json). Measured on Spectra 6 panels
 * in general, not on ours. The same package also ships an older
 * `spectra6legacy` profile and aitjcize's esp32-photoframe measurements
 * (`aitjcize-spectra6`), which differ noticeably (e.g. white #BEC8C8 vs
 * #B9C7C9, red #871300 vs #62201E) - panels, lighting and cameras vary. To
 * calibrate for our own hardware, photograph a panel showing six solid
 * swatches next to a gray card under neutral light, white-balance on the
 * card, and sample the swatch centers.
 */
export const PANEL_APPEARANCE: Rgb[] = [
  { r: 0x1f, g: 0x22, b: 0x26 }, // 0: Black  #1F2226
  { r: 0xb9, g: 0xc7, b: 0xc9 }, // 1: White  #B9C7C9
  { r: 0xc1, g: 0xbb, b: 0x1e }, // 2: Yellow #C1BB1E
  { r: 0x62, g: 0x20, b: 0x1e }, // 3: Red    #62201E
  { r: 0x23, g: 0x3f, b: 0x8e }, // 4: Blue   #233F8E
  { r: 0x35, g: 0x56, b: 0x3a }, // 5: Green  #35563A
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
