import { BOARD_GEOMETRY, type BoardId } from "../lib/media-constants";
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
 * Where within the cover-fit image the board's upright crop is taken from.
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
 * Cap for the "storage original" — the re-encoded copy we persist in place of
 * the as-uploaded file. Must comfortably exceed the largest board's packed
 * geometry (EE02: 1600x1200) × the crop UI's max zoom (3x) so a rotation's
 * re-derive (admin.ts's reencryptOneImage, which re-crops from this blob with
 * DEFAULT_CROP) still has pixels to work with at max zoom-in, while bounding
 * the stored blob (and any upload) to a few hundred KB of JPEG instead of a
 * multi-megabyte camera original.
 */
export const STORAGE_MAX_DIMENSION = 2560;
const STORAGE_JPEG_QUALITY = 0.85;

/**
 * Decode -> EXIF-correct -> downscale (never upscale) to at most
 * STORAGE_MAX_DIMENSION on the long side -> re-encode as JPEG. Replaces the
 * as-uploaded file in the storage-original slot: the Worker never sees (or
 * stores) the original bytes, KV usage stays bounded, and the lightbox still
 * gets a high-quality preview. Re-encoded on white — JPEG has no alpha, and a
 * transparent PNG uploaded as a photo should read as white on the e-ink panel
 * (the display's resting color), not black.
 */
export async function resizeForStorage(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, STORAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: STORAGE_JPEG_QUALITY });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/**
 * Decode -> EXIF-correct -> cover-fit to `targetWidth`x`targetHeight`,
 * cropped per `crop` (see CropParams). Exported on its own so the upload
 * flow can generate the dashboard thumbnail from this exact crop, in
 * natural upright orientation, before any rotation.
 */
async function decodeToUprightBuffer(
  file: Blob,
  crop: CropParams,
  targetWidth: number,
  targetHeight: number
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    const scale = Math.max(targetWidth / width, targetHeight / height) * Math.max(1, crop.zoom);
    const scaledW = Math.max(targetWidth, Math.round(width * scale));
    const scaledH = Math.max(targetHeight, Math.round(height * scale));
    const excessX = scaledW - targetWidth;
    const excessY = scaledH - targetHeight;
    const x1 = Math.round(excessX * Math.min(1, Math.max(0, crop.panX)));
    const y1 = Math.round(excessY * Math.min(1, Math.max(0, crop.panY)));

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Scale first (draw at scaledW x scaledH), then crop by offsetting the
    // draw so the excess falls outside the targetWidth x targetHeight
    // canvas, per panX/panY.
    ctx.drawImage(bitmap, -x1, -y1, scaledW, scaledH);

    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    return { rgba: imageData.data, width: targetWidth, height: targetHeight };
  } finally {
    bitmap.close();
  }
}

/**
 * Decode -> EXIF-correct -> crop -> orient for `board`'s screen (see
 * lib/media-constants.ts's BoardGeometry). A board mounted physically
 * rotated (needsRotation, currently both EE02 and EE04) is cropped to an
 * upright canvas here and then rotated 90°CW to match its native landscape
 * buffer — the driver itself does no on-device rotation either way. A board
 * mounted flat (none currently) would be cropped directly to its native
 * size, no rotation step. `upright` is always the crop before any rotation,
 * in natural viewing orientation — used to generate the dashboard thumbnail.
 */
export async function decodeToBoardBuffer(file: Blob, crop: CropParams = DEFAULT_CROP, board: BoardId): Promise<{
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  upright: { rgba: Uint8ClampedArray; width: number; height: number };
}> {
  const geometry = BOARD_GEOMETRY[board];
  const uprightWidth = geometry.needsRotation ? geometry.displayHeight : geometry.displayWidth;
  const uprightHeight = geometry.needsRotation ? geometry.displayWidth : geometry.displayHeight;

  let upright;
  try {
    upright = await decodeToUprightBuffer(file, crop, uprightWidth, uprightHeight);
  } catch (err) {
    const hint = /heic|heif/i.test((file as File).name ?? "")
      ? " HEIC/HEIF may not be supported by this browser — try converting to JPEG first (e.g. iOS share sheet 'Most Compatible')."
      : "";
    throw new Error(`Failed to decode image.${hint} (${(err as Error).message})`);
  }

  if (!geometry.needsRotation) {
    return { ...upright, upright };
  }

  // Hand-rolled rather than a generic canvas rotate, so exact output
  // dimensions match the firmware's fixed buffer size.
  const landscape = rotate90CW(upright.rgba, upright.width, upright.height);

  if (landscape.width !== geometry.displayWidth || landscape.height !== geometry.displayHeight) {
    throw new Error(`Unexpected buffer size after rotation: ${landscape.width}x${landscape.height}`);
  }

  return { ...landscape, upright };
}
