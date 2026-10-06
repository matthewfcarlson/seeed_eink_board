// Long side of the dashboard thumbnail. The short side follows the crop's own
// aspect ratio (EE02's upright crop is 3:4 -> 120x160, EE04's is 3:5 ->
// 96x160) - a fixed 120x160 box used to squash EE04's preview.
const THUMBNAIL_LONG_SIDE = 160;
const THUMBNAIL_JPEG_QUALITY = 0.7;

// The cropped source (migrations/0028_image_cropped_source.sql) is what a
// future re-render dithers from, so it's kept at the board's full resolution
// and a high quality - JPEG artifacts at this level vanish under dithering.
const CROPPED_SOURCE_JPEG_QUALITY = 0.92;

function rgbaToCanvas(rgba: Uint8ClampedArray, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}

async function canvasToJpeg(canvas: OffscreenCanvas, quality: number): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Fits `width`x`height` inside a THUMBNAIL_LONG_SIDE box, keeping its aspect
 *  ratio (never upscales). Exported for scripts/upload-images.ts's twin. */
export function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, THUMBNAIL_LONG_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Browser replacement for the Worker's old Photon-based lib/thumbnail.ts.
 *  Downscales a board's upright crop (see client/decode.ts) to a JPEG
 *  thumbnail via OffscreenCanvas — no WASM image library needed client-side. */
export async function makeThumbnailJpeg(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const src = rgbaToCanvas(rgba, width, height);
  const size = thumbnailSize(width, height);

  const dst = new OffscreenCanvas(size.width, size.height);
  const dstCtx = dst.getContext("2d");
  if (!dstCtx) throw new Error("2D canvas context unavailable");
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = "high";
  dstCtx.drawImage(src, 0, 0, size.width, size.height);

  return canvasToJpeg(dst, THUMBNAIL_JPEG_QUALITY);
}

/** Full-resolution JPEG of a board's upright, pre-enhance crop — the
 *  "cropped source" stored alongside each packed variant. */
export async function makeCroppedSourceJpeg(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  return canvasToJpeg(rgbaToCanvas(rgba, width, height), CROPPED_SOURCE_JPEG_QUALITY);
}
