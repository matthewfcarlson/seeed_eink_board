#include "display_render.h"

#include <SDL.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "vendor/stb_image_write.h"

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
        // Resizable: SDL_RenderSetLogicalSize below locks the content to the
        // buffer's own aspect ratio and letterboxes to fit whatever size the
        // user drags the window to, rather than stretching it.
        g_window = SDL_CreateWindow("E-Ink Device Simulator", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                     width, height, SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE);
        g_renderer = SDL_CreateRenderer(g_window, -1, SDL_RENDERER_ACCELERATED);
    } else {
        SDL_SetWindowSize(g_window, width, height);
    }
    g_texture = SDL_CreateTexture(g_renderer, SDL_PIXELFORMAT_RGB24, SDL_TEXTUREACCESS_STREAMING, width, height);
    SDL_RenderSetLogicalSize(g_renderer, width, height);
    g_texW = width;
    g_texH = height;
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

void present(const uint8_t *buffer, size_t bufferSize, int width, int height) {
    if (!buffer || width <= 0 || height <= 0) return;

    // `buffer` is in the hardware's native landscape scan order (width x
    // height, e.g. 1600x1200 - see config.h's DISPLAY_WIDTH/HEIGHT). Every
    // producer of content (worker/src/client/decode.ts for photos,
    // lib/qr-registration.ts for the "scan to register" screen,
    // display.cpp's own drawString() for the config-mode banner) draws in
    // portrait and calls rotate90CW to get here, because the panel is then
    // mounted physically rotated so it reads right-side-up. Undo that
    // rotation - a 90-degree counterclockwise turn - so this window shows
    // the same portrait orientation a real mounted device would.
    int portraitW = height;
    int portraitH = width;
    std::vector<uint8_t> rgb((size_t)portraitW * (size_t)portraitH * 3);
    for (int py = 0; py < portraitH; py++) {
        int landscapeCol = width - 1 - py;
        for (int px = 0; px < portraitW; px++) {
            int landscapeRow = px;
            size_t i = (size_t)landscapeRow * width + landscapeCol;
            size_t byteIdx = i / 2;
            uint8_t byteVal = byteIdx < bufferSize ? buffer[byteIdx] : 0x11;  // 0x11 = two white pixels
            uint8_t nibble = (i % 2 == 0) ? (byteVal >> 4) : (byteVal & 0x0F);
            Rgb c = nibbleToRgb(nibble);
            size_t outIdx = (size_t)py * portraitW + px;
            rgb[outIdx * 3 + 0] = c.r;
            rgb[outIdx * 3 + 1] = c.g;
            rgb[outIdx * 3 + 2] = c.b;
        }
    }

    if (isExportMode()) {
        // No SDL window/renderer needed at all - the RGB buffer above is
        // already exactly what a window would show, so just write it.
        writeJpeg(rgb, portraitW, portraitH);
        return;
    }

    ensureWindow(portraitW, portraitH);
    SDL_UpdateTexture(g_texture, nullptr, rgb.data(), portraitW * 3);
    SDL_RenderClear(g_renderer);
    SDL_RenderCopy(g_renderer, g_texture, nullptr, nullptr);
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
