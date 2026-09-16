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
 * Decode -> EXIF-correct -> cover-fit to portrait 1200x1600 (centered
 * horizontally, anchored to the top — same framing as the old server-side
 * `ImageOps.fit(centering=(0.5, 0.0))`). Exported on its own so the upload flow
 * can generate the dashboard thumbnail from this exact crop, in natural
 * upright orientation, before the 90° rotation below.
 */
async function decodeToPortraitBuffer(file: Blob): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    const scale = Math.max(PORTRAIT_WIDTH / width, PORTRAIT_HEIGHT / height);
    const scaledW = Math.max(PORTRAIT_WIDTH, Math.round(width * scale));
    const scaledH = Math.max(PORTRAIT_HEIGHT, Math.round(height * scale));
    const x1 = Math.max(0, Math.floor((scaledW - PORTRAIT_WIDTH) / 2));

    const canvas = new OffscreenCanvas(PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Scale first (draw at scaledW x scaledH), then crop by offsetting the
    // draw so the excess falls outside the PORTRAIT_WIDTH x PORTRAIT_HEIGHT
    // canvas — centered horizontally, top-anchored (no vertical offset).
    ctx.drawImage(bitmap, -x1, 0, scaledW, scaledH);

    const imageData = ctx.getImageData(0, 0, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
    return { rgba: imageData.data, width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT };
  } finally {
    bitmap.close();
  }
}

export async function decodeToLandscapeBuffer(file: Blob): Promise<{
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  portrait: { rgba: Uint8ClampedArray; width: number; height: number };
}> {
  let portrait;
  try {
    portrait = await decodeToPortraitBuffer(file);
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
