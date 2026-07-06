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
 * Renders a "scan to register this device" screen for an unregistered device:
 * a QR code linking to the admin claim page, plus a short message and the MAC
 * address drawn with a hand-rolled bitmap font (see font5x7.ts — Photon's
 * draw_text is exposed in its types but is a silent no-op in this WASM build,
 * confirmed by testing it against a blank canvas). Built in portrait
 * orientation and rotated 90°CW, matching the same geometry photos go
 * through, so it displays right-side-up on the physical screen. No
 * dithering — QR codes need crisp high-contrast modules, not diffused noise —
 * so pixels are mapped directly to the nearest palette color.
 */
export async function renderRegistrationBuffer(
  mac: string,
  registrationUrl: string
): Promise<{ packed: Uint8Array; hash: string }> {
  const qr = qrcode(0, "M");
  qr.addData(registrationUrl);
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
  drawText5x7(rgba, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, "SCAN TO SET UP", 60, textY, textScale);
  drawText5x7(rgba, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, "THIS FRAME", 60, textY + lineHeight, textScale);
  drawText5x7(rgba, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, formatMac(mac), 60, textY + lineHeight * 2 + 20, textScale);

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
