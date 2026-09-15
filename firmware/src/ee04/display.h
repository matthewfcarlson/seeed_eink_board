#ifndef DISPLAY_H
#define DISPLAY_H

#include <Arduino.h>
#include <SPI.h>
#include "config.h"

/**
 * Seeed 7.3" Six-Color E-Paper Display Driver (EE04 board)
 *
 * Hardware: Single ED2208 controller
 * Resolution: 800 x 480 pixels, 6 colors (Black, White, Red, Yellow, Blue, Green)
 *
 * Unlike the EE02/13.3" driver, this panel has no dual master/slave split and
 * no buffer transpose: it's driven natively 800x480 row-major, so the packed
 * buffer can be pushed to the controller with a single SPI burst.
 *
 * Data Format:
 * - 4-bit per pixel (2 pixels per byte), row-major
 * - Total buffer size: 192,000 bytes
 * - Hardware color codes match the EE02/UC8179 driver's Spectra6Color values
 *   exactly (verified via Seeed_GFX's ED2208 palette-to-wire-code table).
 */

class SixColor73Display {
public:
    SixColor73Display();

    // Initialize display hardware
    bool begin();

    // Load pre-packed 4bpp image data directly into buffer
    // Data should be 192,000 bytes, already in display format
    void loadImageData(const uint8_t* data, size_t length);

    // Display the current buffer contents
    void refresh();

    // Fill entire display with a single color
    void fillColor(uint8_t color);

    // Clear the buffer to a single color (alias for fillColor, reads better at call sites)
    void clear(uint8_t color);

    // Draw text using a built-in 5x7 bitmap font (space, '-', '.', '/', ':', 0-9, A-Z only;
    // any other character is rendered blank). `scale` multiplies each font pixel into a
    // scale x scale block. Does not wrap - use '\n' in text to move to the next line.
    void drawString(uint16_t x, uint16_t y, const String& text, uint8_t color, uint8_t scale = 1);
    void drawChar(uint16_t x, uint16_t y, char c, uint8_t color, uint8_t scale = 1);

    // Put display into a low-power state (power-off; see .cpp for why this isn't
    // the ED2208's separate deep-sleep register — noted as a later follow-up)
    void sleep();

    // Get pointer to internal buffer (for direct manipulation)
    uint8_t* getBuffer() { return buffer_; }
    size_t getBufferSize() { return BUFFER_SIZE; }

    // Exposed for main.cpp's bring-up test pattern (see README bring-up checklist)
    uint8_t getPixel(uint16_t x, uint16_t y);
    void setPixel(uint16_t x, uint16_t y, uint8_t color);

private:
    // Frame buffer — plain allocation, no PSRAM needed at this size (see platformio.ini)
    uint8_t buffer_[BUFFER_SIZE];
    bool spiInitialized_;

    // Hardware control
    void hardwareReset();
    void initializeDisplay();
    void transferData();
    void refreshScreen();
    void powerOff();

    // Wait for display to be ready
    bool waitUntilIdle(uint32_t timeoutMs);

    // SPI operations
    void spiBegin();
    void spiEnd();
    void spiWriteByte(uint8_t data);
    void spiWriteArray(const uint8_t* data, size_t len);

    // Single-controller command helpers (EE02's dual-CS master/slave helpers
    // collapse into these two, since ED2208 has one CS line)
    void sendCommand(uint8_t cmd);
    void sendCommandData(uint8_t cmd, const uint8_t* data, size_t len);
};

// Color codes for the Six-Color 7.3" display — same hardware codes as
// Spectra6Color (firmware/src/ee02/display.h), confirmed identical via
// Seeed_GFX's ED2208 COLOR_GET() table.
namespace SixColor73 {
    const uint8_t BLACK  = 0x00;
    const uint8_t WHITE  = 0x01;
    const uint8_t YELLOW = 0x02;
    const uint8_t RED    = 0x03;
    const uint8_t BLUE   = 0x05;
    const uint8_t GREEN  = 0x06;
}

#endif // DISPLAY_H
