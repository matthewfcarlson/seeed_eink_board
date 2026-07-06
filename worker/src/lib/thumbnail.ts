import { PhotonImage, SamplingFilter, resize } from "@cf-wasm/photon";

// Small enough to embed as a base64 data URL directly in the /admin/images list
// response (no separate authenticated <img> fetch needed) while staying a fair
// preview of the exact 1200x1600 crop the firmware will actually display.
const THUMBNAIL_WIDTH = 120;
const THUMBNAIL_HEIGHT = 160;
const THUMBNAIL_JPEG_QUALITY = 70;

/** Downscales a decoded portrait RGBA buffer (see decode.ts) to a JPEG thumbnail. */
export function makeThumbnailJpeg(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const img = new PhotonImage(new Uint8Array(rgba), width, height);
  const thumb = resize(img, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, SamplingFilter.Lanczos3);
  return thumb.get_bytes_jpeg(THUMBNAIL_JPEG_QUALITY);
}
