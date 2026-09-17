import qrcode from "qrcode-generator";
import { BUFFER_HEIGHT, BUFFER_WIDTH, PORTRAIT_HEIGHT, PORTRAIT_WIDTH } from "../types";
import { computeHash16, packToNibbles } from "./dither";
import { drawText5x7 } from "./font5x7";
import { nearestPaletteIndex } from "./palette";
import { rotate90CW } from "./decode";

function formatMac(mac: string): string {
  return (mac.match(/.{1,2}/g) ?? [mac]).join(":").toUpperCase();
}

/**
 * Renders a QR code plus up to three lines of caption text, in portrait
 * orientation rotated 90°CW to match the same geometry photos go through
 * (so it displays right-side-up on the physical screen). No dithering — QR
 * codes need crisp high-contrast modules, not diffused noise — so pixels
 * are mapped directly to the nearest palette color. Shared by
 * renderRegistrationBuffer (unregistered device) and renderNoBucketBuffer
 * (registered device, zero buckets assigned) below, which differ only in
 * the URL and caption.
 */
async function renderQrScreenBuffer(url: string, lines: string[]): Promise<{ packed: Uint8Array; hash: string }> {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const moduleCount = qr.getModuleCount();

  const rgba = new Uint8ClampedArray(PORTRAIT_WIDTH * PORTRAIT_HEIGHT * 4).fill(255);

  const qrAreaPx = 860;
  const moduleSize = Math.max(1, Math.floor(qrAreaPx / moduleCount));
  const qrSize = moduleSize * moduleCount;
  const qrX = Math.floor((PORTRAIT_WIDTH - qrSize) / 2);
  const qrY = 140;

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!qr.isDark(row, col)) continue;
      const px0 = qrX + col * moduleSize;
      const py0 = qrY + row * moduleSize;
      for (let dy = 0; dy < moduleSize; dy++) {
        const rowOffset = (py0 + dy) * PORTRAIT_WIDTH;
        for (let dx = 0; dx < moduleSize; dx++) {
          const o = (rowOffset + px0 + dx) * 4;
          rgba[o] = 0;
          rgba[o + 1] = 0;
          rgba[o + 2] = 0;
          rgba[o + 3] = 255;
        }
      }
    }
  }

  const textScale = 8;
  const lineHeight = 7 * textScale + 30;
  const textY = qrY + qrSize + 80;
  lines.forEach((line, i) => {
    drawText5x7(rgba, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, line, 60, textY + lineHeight * i + (i > 0 ? 20 : 0), textScale);
  });

  const landscape = rotate90CW(rgba, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);

  if (landscape.width !== BUFFER_WIDTH || landscape.height !== BUFFER_HEIGHT) {
    throw new Error(`Unexpected buffer size after rotation: ${landscape.width}x${landscape.height}`);
  }

  const indices = new Uint8Array(BUFFER_WIDTH * BUFFER_HEIGHT);
  for (let i = 0; i < indices.length; i++) {
    const o = i * 4;
    indices[i] = nearestPaletteIndex(landscape.rgba[o]!, landscape.rgba[o + 1]!, landscape.rgba[o + 2]!);
  }

  const packed = packToNibbles(indices);
  const hash = await computeHash16(packed);
  return { packed, hash };
}

/** Renders a "scan to register this device" screen for an unregistered
 *  device: a QR code linking to the admin claim page, plus the MAC address
 *  drawn with a hand-rolled bitmap font (see font5x7.ts — Photon's draw_text
 *  is exposed in its types but is a silent no-op in this WASM build,
 *  confirmed by testing it against a blank canvas). */
export function renderRegistrationBuffer(mac: string, registrationUrl: string): Promise<{ packed: Uint8Array; hash: string }> {
  return renderQrScreenBuffer(registrationUrl, ["SCAN TO SET UP", "THIS FRAME", formatMac(mac)]);
}

/** Renders a "no images assigned yet" screen for a device that's already
 *  registered/claimed but has zero buckets assigned (device_buckets has no
 *  rows for it) — served by /image_packed in place of a 404, so a frame
 *  never just shows a blank/stale screen after being claimed. The QR links
 *  to that device's bucket-assignment modal in /admin (see
 *  registration-url.ts's assignBucketUrl and admin.ts's ?assign_bucket=
 *  handling). */
export function renderNoBucketBuffer(mac: string, assignUrl: string): Promise<{ packed: Uint8Array; hash: string }> {
  return renderQrScreenBuffer(assignUrl, ["NO IMAGES YET", "SCAN TO ADD SOME", formatMac(mac)]);
}
