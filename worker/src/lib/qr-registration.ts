import qrcode from "qrcode-generator";
import { BOARD_GEOMETRY, type BoardId } from "../types";
import { computeHash16, packToNibbles } from "./dither";
import { drawText5x7 } from "./font5x7";
import { nearestPaletteIndex } from "./palette";
import { rotate90CW } from "./decode";

function formatMac(mac: string): string {
  return (mac.match(/.{1,2}/g) ?? [mac]).join(":").toUpperCase();
}

/**
 * Renders a QR code plus up to three lines of caption text, sized for
 * `board`'s screen (see lib/media-constants.ts's BoardGeometry). A
 * rotation-needing board (EE02) draws onto an upright canvas and rotates
 * 90°CW to match the same geometry photos go through; a board that does no
 * on-device rotation (EE04) draws directly onto its native landscape
 * canvas. No dithering — QR codes need crisp high-contrast modules, not
 * diffused noise — so pixels are mapped directly to the nearest palette
 * color. Shared by renderRegistrationBuffer (unregistered device) and
 * renderNoBucketBuffer (registered device, zero buckets assigned) below,
 * which differ only in the URL and caption.
 */
async function renderQrScreenBuffer(
  url: string,
  lines: string[],
  board: BoardId
): Promise<{ packed: Uint8Array; hash: string }> {
  const geometry = BOARD_GEOMETRY[board];
  const uprightWidth = geometry.needsRotation ? geometry.displayHeight : geometry.displayWidth;
  const uprightHeight = geometry.needsRotation ? geometry.displayWidth : geometry.displayHeight;

  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const moduleCount = qr.getModuleCount();

  const rgba = new Uint8ClampedArray(uprightWidth * uprightHeight * 4).fill(255);

  // Proportional to canvas size rather than fixed pixel constants - boards
  // with very different aspect ratios (EE02's tall portrait-before-rotation
  // vs EE04's native landscape) both need the QR/text to actually fit.
  const shortSide = Math.min(uprightWidth, uprightHeight);
  const qrAreaPx = Math.floor(shortSide * 0.55);
  const moduleSize = Math.max(1, Math.floor(qrAreaPx / moduleCount));
  const qrSize = moduleSize * moduleCount;
  const qrX = Math.floor((uprightWidth - qrSize) / 2);
  const qrY = Math.floor(shortSide * 0.09);

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!qr.isDark(row, col)) continue;
      const px0 = qrX + col * moduleSize;
      const py0 = qrY + row * moduleSize;
      for (let dy = 0; dy < moduleSize; dy++) {
        const rowOffset = (py0 + dy) * uprightWidth;
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

  const textScale = Math.max(1, Math.round(shortSide / 150));
  const lineHeight = 7 * textScale + Math.round(shortSide * 0.02);
  const textY = qrY + qrSize + Math.round(shortSide * 0.05);
  const textX = Math.round(shortSide * 0.05);
  lines.forEach((line, i) => {
    drawText5x7(rgba, uprightWidth, uprightHeight, line, textX, textY + lineHeight * i + (i > 0 ? Math.round(shortSide * 0.013) : 0), textScale);
  });

  let finalRgba: Uint8ClampedArray = rgba;
  let finalWidth = uprightWidth;
  let finalHeight = uprightHeight;
  if (geometry.needsRotation) {
    const rotated = rotate90CW(rgba, uprightWidth, uprightHeight);
    if (rotated.width !== geometry.displayWidth || rotated.height !== geometry.displayHeight) {
      throw new Error(`Unexpected buffer size after rotation: ${rotated.width}x${rotated.height}`);
    }
    finalRgba = rotated.rgba;
    finalWidth = rotated.width;
    finalHeight = rotated.height;
  }

  const indices = new Uint8Array(finalWidth * finalHeight);
  for (let i = 0; i < indices.length; i++) {
    const o = i * 4;
    indices[i] = nearestPaletteIndex(finalRgba[o]!, finalRgba[o + 1]!, finalRgba[o + 2]!);
  }

  const packed = packToNibbles(indices);
  const hash = await computeHash16(packed);
  return { packed, hash };
}

/** Renders a "scan to register this device" screen for an unregistered
 *  device: a QR code linking to the admin claim page, plus the MAC address
 *  drawn with a hand-rolled bitmap font (see font5x7.ts — Photon's draw_text
 *  is exposed in its types but is a silent no-op in this WASM build,
 *  confirmed by testing it against a blank canvas). Sized for `board` (the
 *  device's own X-Device-Board header — this device has no DB row yet, so
 *  there's no devices.board to read back). */
export function renderRegistrationBuffer(
  mac: string,
  registrationUrl: string,
  board: BoardId
): Promise<{ packed: Uint8Array; hash: string }> {
  return renderQrScreenBuffer(registrationUrl, ["SCAN TO SET UP", "THIS FRAME", formatMac(mac)], board);
}

/** Renders a "no images assigned yet" screen for a device that's already
 *  registered/claimed but has zero buckets assigned (device_buckets has no
 *  rows for it), or whose only pending image belongs to a bucket packed for
 *  a different board — served by /image_packed in place of a 404 or a
 *  wrong-sized buffer, so a frame never just shows a blank/stale/corrupt
 *  screen. The QR links to that device's bucket-assignment modal in /admin
 *  (see registration-url.ts's assignBucketUrl and admin.ts's
 *  ?assign_bucket= handling). */
export function renderNoBucketBuffer(
  mac: string,
  assignUrl: string,
  board: BoardId
): Promise<{ packed: Uint8Array; hash: string }> {
  return renderQrScreenBuffer(assignUrl, ["NO IMAGES YET", "SCAN TO ADD SOME", formatMac(mac)], board);
}
