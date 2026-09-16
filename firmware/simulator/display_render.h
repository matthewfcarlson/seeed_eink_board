#pragma once
#include <cstddef>
#include <cstdint>

/**
 * Renders a board's packed 4bpp display buffer into a live SDL2 window.
 * Board-agnostic on purpose: main_native.cpp passes width/height/buffer
 * explicitly (rather than this header depending on either board's
 * DISPLAY_WIDTH/HEIGHT macros) since it's compiled as its own translation
 * unit, separate from whichever board's config.h main_native.cpp pulled in.
 *
 * No SDL_ttf/font loading here - see the plan's Context section: every pixel
 * this ever shows is already baked into the buffer before render time (by
 * display.cpp's own drawString() for the config-mode banner, or server-side
 * by the Worker for the QR "scan to register" screen), so this is just a
 * palette-indexed blit.
 */
namespace DisplayRender {

// Same numbered-JPEG export scheme as ~/git/epaper_clock/simulator/EPaperSim.h:
// "clock.jpg" -> "clock_01.jpg", "clock_02.jpg", ... Call before the first
// present(); once set, present() writes a JPEG instead of opening a window -
// no SDL/WindowServer needed at all (unlike epaper_clock, present() already
// has the fully-decoded RGB buffer in hand before it would ever touch SDL,
// so there's nothing to read back from a renderer). Useful for headless/CI
// use or scripting a single snapshot without babysitting a live window.
void setExportPath(const char *path);
bool isExportMode();

// Buffer packing matches worker/src/lib/dither.ts's packToNibbles() / each
// board's display.cpp setPixel(): row-major, high nibble = even pixel index,
// low nibble = odd pixel index. Opens the window on first call (skipped
// entirely in export mode - see setExportPath()); safe to call repeatedly
// with the same size (typical - only one board per process).
void present(const uint8_t *buffer, size_t bufferSize, int width, int height);

// Pumps the SDL event queue. Returns true if Space was pressed since the
// last call (manual "wake now", standing in for a real deep-sleep timer
// elapsing). Sets *quit true if the window was closed. Never call this in
// export mode - no SDL window/event queue exists to pump.
bool pollWakeOrQuit(bool *quit);

}  // namespace DisplayRender
