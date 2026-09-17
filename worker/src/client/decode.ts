import { BUFFER_HEIGHT, BUFFER_WIDTH, PORTRAIT_HEIGHT, PORTRAIT_WIDTH } from "../lib/media-constants";
import { rotate90CW } from "../lib/decode";

/**
 * Browser replacement for the Worker's old Photon-based lib/decode.ts (removed
 * once image ingestion moved client-side — see root CLAUDE.md's encrypted-
 * buckets plan). `createImageBitmap`'s `imageOrientation: "from-image"` handles
 * EXIF auto-rotation natively, so there's no manual EXIF reader here (the old
 * lib/exif.ts is gone entirely). `rotate90CW` is still shared with the Worker's
 * lib/decode.ts, which kept it for the synthetic QR-registration screen.
 */

/**
 * Where within the cover-fit image the 1200x1600 portrait crop is taken from.
 * `zoom >= 1` multiplies the minimum cover-fit scale (1 = as tight a fit as
 * possible with no dead space); `panX`/`panY` in [0, 1] pick where within the
 * resulting excess width/height the crop window sits (0 = left/top edge of
 * the scaled image, 1 = right/bottom edge, 0.5 = centered). The old fixed
 * behavior — centered horizontally, anchored to the top, no zoom — is exactly
 * `{ panX: 0.5, panY: 0, zoom: 1 }`, kept as the default so callers that don't
 * care about crop placement (or can't offer a picker) see no change. Driven
 * interactively by admin.ts's crop tool; see its `CropState`.
 */
export interface CropParams {
  panX: number;
  panY: number;
  zoom: number;
}
export const DEFAULT_CROP: CropParams = { panX: 0.5, panY: 0, zoom: 1 };

/**
 * Decode -> EXIF-correct -> cover-fit to portrait 1200x1600, cropped per
 * `crop` (see CropParams). Exported on its own so the upload flow can
 * generate the dashboard thumbnail from this exact crop, in natural upright
 * orientation, before the 90° rotation below.
 */
async function decodeToPortraitBuffer(
  file: Blob,
  crop: CropParams
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    const scale = Math.max(PORTRAIT_WIDTH / width, PORTRAIT_HEIGHT / height) * Math.max(1, crop.zoom);
    const scaledW = Math.max(PORTRAIT_WIDTH, Math.round(width * scale));
    const scaledH = Math.max(PORTRAIT_HEIGHT, Math.round(height * scale));
    const excessX = scaledW - PORTRAIT_WIDTH;
    const excessY = scaledH - PORTRAIT_HEIGHT;
    const x1 = Math.round(excessX * Math.min(1, Math.max(0, crop.panX)));
    const y1 = Math.round(excessY * Math.min(1, Math.max(0, crop.panY)));

    const canvas = new OffscreenCanvas(PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Scale first (draw at scaledW x scaledH), then crop by offsetting the
    // draw so the excess falls outside the PORTRAIT_WIDTH x PORTRAIT_HEIGHT
    // canvas, per panX/panY.
    ctx.drawImage(bitmap, -x1, -y1, scaledW, scaledH);

    const imageData = ctx.getImageData(0, 0, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
    return { rgba: imageData.data, width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT };
  } finally {
    bitmap.close();
  }
}

export async function decodeToLandscapeBuffer(file: Blob, crop: CropParams = DEFAULT_CROP): Promise<{
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  portrait: { rgba: Uint8ClampedArray; width: number; height: number };
}> {
  let portrait;
  try {
    portrait = await decodeToPortraitBuffer(file, crop);
  } catch (err) {
    const hint = /heic|heif/i.test((file as File).name ?? "")
      ? " HEIC/HEIF may not be supported by this browser — try converting to JPEG first (e.g. iOS share sheet 'Most Compatible')."
      : "";
    throw new Error(`Failed to decode image.${hint} (${(err as Error).message})`);
  }

  // Hand-rolled rather than a generic canvas rotate, so exact output
  // dimensions match the firmware's fixed buffer size.
  const landscape = rotate90CW(portrait.rgba, portrait.width, portrait.height);

  if (landscape.width !== BUFFER_WIDTH || landscape.height !== BUFFER_HEIGHT) {
    throw new Error(`Unexpected buffer size after rotation: ${landscape.width}x${landscape.height}`);
  }

  return { ...landscape, portrait };
}
