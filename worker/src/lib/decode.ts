import { PhotonImage, SamplingFilter, crop, resize } from "@cf-wasm/photon";
import { BUFFER_HEIGHT, BUFFER_WIDTH, PORTRAIT_HEIGHT, PORTRAIT_WIDTH } from "../types";
import { applyOrientation, readJpegOrientation } from "./exif";

// @cf-wasm/photon's "workerd" build (resolved automatically by wrangler's bundler
// via the `workerd` export condition) self-initializes its WASM module at import
// time — no separate initPhoton() call needed here.

const SUPPORTED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"]);

export function isSupportedImageType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED_CONTENT_TYPES.has(base);
}

/** HEIC/HEIF is intentionally unsupported (see plan §Upload pipeline) — reject early
 *  with a clear error rather than letting Photon fail opaquely on it. */
export function isHeic(contentType: string | null, filename: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("heic") || ct.includes("heif")) return true;
  return /\.(heic|heif)$/i.test(filename);
}

export function rotate90CW(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const outW = height;
  const outH = width;
  const out = new Uint8ClampedArray(rgba.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = height - 1 - y;
      const dy = x;
      const srcOffset = (y * width + x) * 4;
      const dstOffset = (dy * outW + dx) * 4;
      out[dstOffset] = rgba[srcOffset]!;
      out[dstOffset + 1] = rgba[srcOffset + 1]!;
      out[dstOffset + 2] = rgba[srcOffset + 2]!;
      out[dstOffset + 3] = rgba[srcOffset + 3]!;
    }
  }

  return { rgba: out, width: outW, height: outH };
}

/**
 * Decode -> EXIF-correct -> cover-fit to portrait 1200x1600 (centered horizontally,
 * anchored to the top, matching PIL's `ImageOps.fit(centering=(0.5, 0.0))`) -> rotate
 * 90° CW to the final 1600x1200 landscape buffer. Mirrors image_server.py's geometry
 * exactly; enhancement/dithering/packing happen separately (see dither.ts).
 */
export async function decodeToLandscapeBuffer(
  bytes: Uint8Array
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  let orientation = 1;
  try {
    orientation = readJpegOrientation(bytes);
  } catch {
    orientation = 1;
  }

  let img = PhotonImage.new_from_byteslice(bytes);
  let width = img.get_width();
  let height = img.get_height();
  let rgba: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray(img.get_raw_pixels());

  if (orientation !== 1) {
    const corrected = applyOrientation(rgba, width, height, orientation);
    rgba = corrected.rgba;
    width = corrected.width;
    height = corrected.height;
    img = new PhotonImage(new Uint8Array(rgba), width, height);
  }

  const scale = Math.max(PORTRAIT_WIDTH / width, PORTRAIT_HEIGHT / height);
  const scaledW = Math.max(PORTRAIT_WIDTH, Math.round(width * scale));
  const scaledH = Math.max(PORTRAIT_HEIGHT, Math.round(height * scale));

  const resized = resize(img, scaledW, scaledH, SamplingFilter.Lanczos3);
  const x1 = Math.max(0, Math.floor((scaledW - PORTRAIT_WIDTH) / 2));
  const cropped = crop(resized, x1, 0, x1 + PORTRAIT_WIDTH, PORTRAIT_HEIGHT);

  const portraitRgba = new Uint8ClampedArray(cropped.get_raw_pixels());

  // Hand-rolled rather than trusting a generic WASM rotate for an orthogonal
  // rotation, where exact output dimensions matter for the firmware's fixed buffer.
  const landscape = rotate90CW(portraitRgba, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);

  if (landscape.width !== BUFFER_WIDTH || landscape.height !== BUFFER_HEIGHT) {
    throw new Error(`Unexpected buffer size after rotation: ${landscape.width}x${landscape.height}`);
  }

  return landscape;
}
