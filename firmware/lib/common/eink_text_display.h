#pragma once

#include <Arduino.h>

/**
 * Shared bitmap-font text rendering + 4bpp buffer pixel access for every
 * board's e-ink display driver (firmware/src/ee02/display.h's Spectra6Display,
 * firmware/src/ee04/display.h's SixColor73Display). Ported near-verbatim from
 * an earlier copy of this code duplicated in both display.cpp files -
 * consolidated here once it was confirmed byte-for-byte identical between
 * them, same "shared logic in lib/common, hardware specifics in src/<board>"
 * split device_app.h already uses for the rest of the app (see root
 * CLAUDE.md's "Files" section).
 *
 * CRTP: Derived must publicly provide getBuffer()/getBufferSize() (both
 * boards already do, for the same reason device_app.h needs them). Every
 * method here reaches the frame buffer only through those two calls plus the
 * WIDTH/HEIGHT template parameters - it never touches SPI, a controller
 * register, or anything else that's genuinely hardware-specific. Each
 * board's own display.cpp keeps everything that does differ: SPI protocol,
 * controller init sequences, begin()/refresh()/sleep(), and buffer
 * allocation (EE02's is heap/PSRAM and can fail to allocate - hence the
 * nullptr checks below still needed even though EE04's static array never
 * is null).
 */
namespace EinkFont5x7 {

// Minimal built-in 5x7 bitmap font covering ' ', '-', '.', '/', ':', '0'-'9',
// 'A'-'Z' (everything else renders as a blank cell) - enough for status
// screens like the config-mode banner without pulling in a full graphics
// library. Indexed by (char - 0x20); each glyph is 7 rows of 5 bits (bit4 =
// leftmost pixel). `inline constexpr` (C++17) rather than `static const` at
// namespace scope so every board's translation unit that includes this
// header shares one definition instead of each getting its own copy.
inline constexpr uint8_t GLYPHS[][7] = {
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x20 ' '
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x21 '!'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x22 '"'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x23 '#'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x24 '$'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x25 '%'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x26 '&'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x27 '\''
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x28 '('
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x29 ')'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x2A '*'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x2B '+'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x2C ','
    {0x00,0x00,0x00,0x1F,0x00,0x00,0x00}, // 0x2D '-'
    {0x00,0x00,0x00,0x00,0x00,0x0C,0x0C}, // 0x2E '.'
    {0x01,0x02,0x04,0x04,0x08,0x10,0x10}, // 0x2F '/'
    {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E}, // 0x30 '0'
    {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E}, // 0x31 '1'
    {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F}, // 0x32 '2'
    {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E}, // 0x33 '3'
    {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02}, // 0x34 '4'
    {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E}, // 0x35 '5'
    {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E}, // 0x36 '6'
    {0x1F,0x01,0x02,0x04,0x08,0x08,0x08}, // 0x37 '7'
    {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E}, // 0x38 '8'
    {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C}, // 0x39 '9'
    {0x00,0x0C,0x0C,0x00,0x00,0x0C,0x0C}, // 0x3A ':'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x3B ';'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x3C '<'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x3D '='
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x3E '>'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x3F '?'
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00}, // 0x40 '@'
    {0x0E,0x11,0x11,0x1F,0x11,0x11,0x11}, // 0x41 'A'
    {0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E}, // 0x42 'B'
    {0x0F,0x10,0x10,0x10,0x10,0x10,0x0F}, // 0x43 'C'
    {0x1E,0x11,0x11,0x11,0x11,0x11,0x1E}, // 0x44 'D'
    {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F}, // 0x45 'E'
    {0x1F,0x10,0x10,0x1E,0x10,0x10,0x10}, // 0x46 'F'
    {0x0F,0x10,0x10,0x17,0x11,0x11,0x0F}, // 0x47 'G'
    {0x11,0x11,0x11,0x1F,0x11,0x11,0x11}, // 0x48 'H'
    {0x0E,0x04,0x04,0x04,0x04,0x04,0x0E}, // 0x49 'I'
    {0x01,0x01,0x01,0x01,0x01,0x11,0x0E}, // 0x4A 'J'
    {0x11,0x12,0x14,0x18,0x14,0x12,0x11}, // 0x4B 'K'
    {0x10,0x10,0x10,0x10,0x10,0x10,0x1F}, // 0x4C 'L'
    {0x11,0x1B,0x15,0x15,0x11,0x11,0x11}, // 0x4D 'M'
    {0x11,0x19,0x15,0x15,0x13,0x11,0x11}, // 0x4E 'N'
    {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E}, // 0x4F 'O'
    {0x1E,0x11,0x11,0x1E,0x10,0x10,0x10}, // 0x50 'P'
    {0x0E,0x11,0x11,0x11,0x15,0x12,0x0D}, // 0x51 'Q'
    {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11}, // 0x52 'R'
    {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E}, // 0x53 'S'
    {0x1F,0x04,0x04,0x04,0x04,0x04,0x04}, // 0x54 'T'
    {0x11,0x11,0x11,0x11,0x11,0x11,0x0E}, // 0x55 'U'
    {0x11,0x11,0x11,0x11,0x11,0x0A,0x04}, // 0x56 'V'
    {0x11,0x11,0x11,0x15,0x15,0x15,0x0A}, // 0x57 'W'
    {0x11,0x11,0x0A,0x04,0x0A,0x11,0x11}, // 0x58 'X'
    {0x11,0x11,0x0A,0x04,0x04,0x04,0x04}, // 0x59 'Y'
    {0x1F,0x01,0x02,0x04,0x08,0x10,0x1F}, // 0x5A 'Z'
};

}  // namespace EinkFont5x7

template <typename Derived, uint16_t WIDTH, uint16_t HEIGHT>
class EinkTextDisplay {
public:
    // Buffer format: 4 bits per pixel, 2 pixels per byte, row-major - same
    // layout worker/src/lib/dither.ts's packToNibbles() produces and every
    // board's loadImageData() expects. `Derived::getBuffer()` may return
    // nullptr (EE02's PSRAM allocation can fail; see Spectra6Display's
    // constructor) even though EE04's static-array buffer never is - the
    // check is kept unconditional here since it's cheap and correct for both.
    uint8_t getPixel(uint16_t x, uint16_t y) {
        uint8_t* buf = self()->getBuffer();
        if (buf == nullptr || x >= WIDTH || y >= HEIGHT) return 0;
        size_t byteIdx = ((size_t)y * WIDTH + x) / 2;
        uint8_t b = buf[byteIdx];
        return (x & 1) ? (b & 0x0F) : ((b >> 4) & 0x0F);
    }

    void setPixel(uint16_t x, uint16_t y, uint8_t color) {
        uint8_t* buf = self()->getBuffer();
        if (buf == nullptr || x >= WIDTH || y >= HEIGHT) return;
        size_t byteIdx = ((size_t)y * WIDTH + x) / 2;
        uint8_t existing = buf[byteIdx];
        if (x & 1) {
            buf[byteIdx] = (existing & 0xF0) | (color & 0x0F);
        } else {
            buf[byteIdx] = (existing & 0x0F) | ((color & 0x0F) << 4);
        }
    }

    void fillColor(uint8_t color) {
        uint8_t* buf = self()->getBuffer();
        if (buf == nullptr) return;
        uint8_t byteVal = (color << 4) | color;
        memset(buf, byteVal, self()->getBufferSize());
    }

    // Alias for fillColor() - reads better at call sites.
    void clear(uint8_t color) { fillColor(color); }

    // Draw text using the built-in 5x7 bitmap font (see EinkFont5x7::GLYPHS
    // above for supported characters). `scale` multiplies each font pixel
    // into a scale x scale block. Does not wrap - use '\n' in text to move
    // to the next line. Coordinates are in the panel's native landscape
    // buffer space (x < WIDTH, y < HEIGHT) - same space loadImageData()
    // addresses.
    void drawChar(uint16_t x, uint16_t y, char c, uint8_t color, uint8_t scale = 1) {
        if (c < 0x20 || c > 0x5A) c = ' ';
        const uint8_t* glyph = EinkFont5x7::GLYPHS[c - 0x20];

        for (uint8_t row = 0; row < 7; row++) {
            uint8_t bits = glyph[row];
            for (uint8_t col = 0; col < 5; col++) {
                if (!(bits & (0x10 >> col))) continue;
                for (uint8_t sy = 0; sy < scale; sy++) {
                    for (uint8_t sx = 0; sx < scale; sx++) {
                        setPixel(x + col * scale + sx, y + row * scale + sy, color);
                    }
                }
            }
        }
    }

    void drawString(uint16_t x, uint16_t y, const String& text, uint8_t color, uint8_t scale = 1) {
        const uint16_t charWidth = 6 * scale;   // 5 pixel glyph + 1 pixel gap
        const uint16_t lineHeight = 9 * scale;  // 7 pixel glyph + 2 pixel gap
        uint16_t cursorX = x;
        uint16_t cursorY = y;

        for (size_t i = 0; i < text.length(); i++) {
            char c = text[i];
            if (c == '\n') {
                cursorX = x;
                cursorY += lineHeight;
                continue;
            }
            drawChar(cursorX, cursorY, c, color, scale);
            cursorX += charWidth;
        }
    }

    // Portrait-space variants of the above. drawChar()/drawString() address
    // the buffer in the panel's native landscape layout (matches
    // loadImageData()'s buffer format). Every panel is physically mounted
    // rotated 90 degrees, so normal image content - rotated the same way
    // server-side by the Worker's rotate90CW (see worker/src/lib/decode.ts) -
    // reads right-side up. These variants apply that identical rotation to
    // text, so banners like the config-mode screen also read right-side up
    // on a mounted device instead of sideways. Portrait canvas is HEIGHT
    // wide x WIDTH tall (axes swapped vs. the native landscape buffer);
    // mirrors rotate90CW's mapping.
    void setPixelPortrait(uint16_t x, uint16_t y, uint8_t color) {
        if (x >= HEIGHT || y >= WIDTH) return;
        setPixel(WIDTH - 1 - y, x, color);
    }

    void drawCharPortrait(uint16_t x, uint16_t y, char c, uint8_t color, uint8_t scale = 1) {
        if (c < 0x20 || c > 0x5A) c = ' ';
        const uint8_t* glyph = EinkFont5x7::GLYPHS[c - 0x20];

        for (uint8_t row = 0; row < 7; row++) {
            uint8_t bits = glyph[row];
            for (uint8_t col = 0; col < 5; col++) {
                if (!(bits & (0x10 >> col))) continue;
                for (uint8_t sy = 0; sy < scale; sy++) {
                    for (uint8_t sx = 0; sx < scale; sx++) {
                        setPixelPortrait(x + col * scale + sx, y + row * scale + sy, color);
                    }
                }
            }
        }
    }

    void drawStringPortrait(uint16_t x, uint16_t y, const String& text, uint8_t color, uint8_t scale = 1) {
        const uint16_t charWidth = 6 * scale;
        const uint16_t lineHeight = 9 * scale;
        uint16_t cursorX = x;
        uint16_t cursorY = y;

        for (size_t i = 0; i < text.length(); i++) {
            char c = text[i];
            if (c == '\n') {
                cursorX = x;
                cursorY += lineHeight;
                continue;
            }
            drawCharPortrait(cursorX, cursorY, c, color, scale);
            cursorX += charWidth;
        }
    }

private:
    Derived* self() { return static_cast<Derived*>(this); }
};
