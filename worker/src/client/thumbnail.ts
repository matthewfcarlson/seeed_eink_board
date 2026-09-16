// Small enough to be a fair preview of the exact 1200x1600 crop the firmware
// will actually display, without needing to ship/decrypt the full original.
const THUMBNAIL_WIDTH = 120;
const THUMBNAIL_HEIGHT = 160;
const THUMBNAIL_JPEG_QUALITY = 0.7;

/** Browser replacement for the Worker's old Photon-based lib/thumbnail.ts.
 *  Downscales a decoded portrait RGBA buffer (see client/decode.ts) to a JPEG
 *  thumbnail via OffscreenCanvas — no WASM image library needed client-side. */
export async function makeThumbnailJpeg(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const src = new OffscreenCanvas(width, height);
  const srcCtx = src.getContext("2d");
  if (!srcCtx) throw new Error("2D canvas context unavailable");
  srcCtx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

  const dst = new OffscreenCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const dstCtx = dst.getContext("2d");
  if (!dstCtx) throw new Error("2D canvas context unavailable");
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = "high";
  dstCtx.drawImage(src, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  const blob = await dst.convertToBlob({ type: "image/jpeg", quality: THUMBNAIL_JPEG_QUALITY });
  return new Uint8Array(await blob.arrayBuffer());
}
