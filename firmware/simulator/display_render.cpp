#include "display_render.h"

#include <SDL.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "vendor/stb_image_write.h"

#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

namespace DisplayRender {
namespace {

SDL_Window *g_window = nullptr;
SDL_Renderer *g_renderer = nullptr;
SDL_Texture *g_texture = nullptr;
int g_texW = 0;
int g_texH = 0;
std::string g_windowTitle = "E-Ink Device Simulator";

// Export mode (see setExportPath()) - numbered-JPEG scheme ported from
// ~/git/epaper_clock/simulator/EPaperSim.h.
std::string g_exportStem;
std::string g_exportExt;
int g_exportFrameCount = 0;

struct Rgb {
    uint8_t r, g, b;
};

// Mirrors worker/src/lib/palette.ts's PALETTE/NIBBLE_MAP and each board's
// Spectra6Color/SixColor73 hardware nibble codes exactly.
Rgb nibbleToRgb(uint8_t nibble) {
    switch (nibble) {
        case 0x0: return {0, 0, 0};        // Black
        case 0x1: return {255, 255, 255};  // White
        case 0x2: return {255, 255, 0};    // Yellow
        case 0x3: return {255, 0, 0};      // Red
        case 0x5: return {0, 0, 255};      // Blue
        case 0x6: return {41, 204, 20};    // Green
        default:  return {255, 0, 255};    // Unrecognized - magenta makes decode bugs obvious
    }
}

void ensureWindow(int width, int height) {
    if (g_window && g_texW == width && g_texH == height) return;

    if (g_texture) {
        SDL_DestroyTexture(g_texture);
        g_texture = nullptr;
    }
    if (!g_window) {
        SDL_Init(SDL_INIT_VIDEO);
        // Resizable: present() computes a letterboxed destination rect every
        // frame (see below) to keep the buffer's own aspect ratio locked and
        // fit within whatever size the user drags the window to, rather than
        // stretching it. (SDL_RenderSetLogicalSize looks like it should do
        // this automatically, but its auto-letterboxing has proven flaky on
        // macOS/Metal for tall aspect ratios like EE04's 480x800 - resizing
        // wide would stretch content instead of letterboxing - so this does
        // it manually instead.)
        g_window = SDL_CreateWindow(g_windowTitle.c_str(), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                     width, height, SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE);
        g_renderer = SDL_CreateRenderer(g_window, -1, SDL_RENDERER_ACCELERATED);
    } else {
        SDL_SetWindowSize(g_window, width, height);
    }
    g_texture = SDL_CreateTexture(g_renderer, SDL_PIXELFORMAT_RGB24, SDL_TEXTUREACCESS_STREAMING, width, height);
    g_texW = width;
    g_texH = height;
}

// Largest width x height x centered offset for a g_texW x g_texH texture
// that fits inside the renderer's current output size without exceeding it
// or distorting its aspect ratio - i.e. manual letterboxing.
SDL_Rect letterboxDestRect() {
    int outputW = 0, outputH = 0;
    SDL_GetRendererOutputSize(g_renderer, &outputW, &outputH);
    if (outputW <= 0 || outputH <= 0 || g_texW <= 0 || g_texH <= 0) {
        return SDL_Rect{0, 0, outputW, outputH};
    }
    double scale = std::min((double)outputW / g_texW, (double)outputH / g_texH);
    int destW = (int)(g_texW * scale);
    int destH = (int)(g_texH * scale);
    return SDL_Rect{(outputW - destW) / 2, (outputH - destH) / 2, destW, destH};
}

void writeJpeg(const std::vector<uint8_t> &rgb, int width, int height) {
    char path[1024];
    snprintf(path, sizeof(path), "%s_%02d%s", g_exportStem.c_str(), ++g_exportFrameCount, g_exportExt.c_str());
    if (stbi_write_jpg(path, width, height, 3, rgb.data(), 90)) {
        printf("DisplayRender: saved %s\n", path);
    } else {
        fprintf(stderr, "DisplayRender: failed to write %s\n", path);
    }
}

}  // namespace

void setExportPath(const char *path) {
    std::string s(path);
    auto dot = s.rfind('.');
    if (dot != std::string::npos) {
        g_exportStem = s.substr(0, dot);
        g_exportExt = s.substr(dot);  // includes the dot
    } else {
        g_exportStem = s;
        g_exportExt = ".jpg";
    }
}

bool isExportMode() { return !g_exportStem.empty(); }

void setWindowTitle(const char *title) {
    g_windowTitle = title;
    if (g_window) SDL_SetWindowTitle(g_window, g_windowTitle.c_str());
}

void present(const uint8_t *buffer, size_t bufferSize, int width, int height, bool undoMountRotation) {
    if (!buffer || width <= 0 || height <= 0) return;

    // `buffer` is in the hardware's native scan order (width x height, e.g.
    // 1600x1200 for EE02, 800x480 for EE04 - see config.h's DISPLAY_WIDTH/
    // HEIGHT). When undoMountRotation is set (both EE02 and EE04 - portrait
    // only for now), every producer of content (worker/src/client/decode.ts
    // for photos, lib/qr-registration.ts for the "scan to register" screen,
    // display.cpp's own drawString() for the config-mode banner) draws in
    // portrait and calls rotate90CW before it ever reaches here, because
    // that panel is mounted physically rotated so it reads right-side-up.
    // Undo that rotation - a 90-degree counterclockwise turn - so this
    // window shows the same portrait orientation a real mounted device
    // would. When it's clear, content is already produced in the panel's
    // native landscape orientation with no rotation at all, so render it
    // straight through - for a board mounted flat; no board currently ships
    // that way.
    int outW = undoMountRotation ? height : width;
    int outH = undoMountRotation ? width : height;
    std::vector<uint8_t> rgb((size_t)outW * (size_t)outH * 3);
    for (int py = 0; py < outH; py++) {
        for (int px = 0; px < outW; px++) {
            size_t i;
            if (undoMountRotation) {
                int landscapeCol = width - 1 - py;
                int landscapeRow = px;
                i = (size_t)landscapeRow * width + landscapeCol;
            } else {
                i = (size_t)py * width + px;
            }
            size_t byteIdx = i / 2;
            uint8_t byteVal = byteIdx < bufferSize ? buffer[byteIdx] : 0x11;  // 0x11 = two white pixels
            uint8_t nibble = (i % 2 == 0) ? (byteVal >> 4) : (byteVal & 0x0F);
            Rgb c = nibbleToRgb(nibble);
            size_t outIdx = (size_t)py * outW + px;
            rgb[outIdx * 3 + 0] = c.r;
            rgb[outIdx * 3 + 1] = c.g;
            rgb[outIdx * 3 + 2] = c.b;
        }
    }
    if (isExportMode()) {
        // No SDL window/renderer needed at all - the RGB buffer above is
        // already exactly what a window would show, so just write it.
        writeJpeg(rgb, outW, outH);
        return;
    }

    ensureWindow(outW, outH);
    SDL_UpdateTexture(g_texture, nullptr, rgb.data(), outW * 3);
    SDL_RenderClear(g_renderer);
    SDL_Rect dest = letterboxDestRect();
    SDL_RenderCopy(g_renderer, g_texture, nullptr, &dest);
    SDL_RenderPresent(g_renderer);
}

bool pollWakeOrQuit(bool *quit) {
    *quit = false;
    bool wake = false;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_QUIT) *quit = true;
        if (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_SPACE) wake = true;
    }
    return wake;
}

}  // namespace DisplayRender
