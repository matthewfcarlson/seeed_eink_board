#pragma once
#include <stdint.h>
#include <cstddef>

// Inert stand-in for ESP32's SPI bus. Both boards' display.cpp use this only
// through spiBegin()/spiWriteByte()/spiWriteArray() (see display.cpp) -
// their SPI.transfer() calls happen while a CS pin is toggled by the stub
// digitalWrite() (a no-op) and gated by a stub digitalRead(PIN_BUSY) that
// always reports "idle" (see Arduino.h), so the real hardwareReset() /
// initializeDisplay() / transferData() / refreshScreen() / powerOff() /
// displaySleep() sequences all run for real, just against a bus that goes
// nowhere - harmless, and fast (no real SPI clock to wait on).
enum { MSBFIRST = 1, LSBFIRST = 0 };
enum { SPI_MODE0 = 0, SPI_MODE1 = 1, SPI_MODE2 = 2, SPI_MODE3 = 3 };

struct SPISettings {
    SPISettings() {}
    SPISettings(uint32_t /*clock*/, uint8_t /*bitOrder*/, uint8_t /*mode*/) {}
};

struct SPIClass {
    void begin(int /*sck*/ = -1, int /*miso*/ = -1, int /*mosi*/ = -1, int /*ss*/ = -1) {}
    void beginTransaction(SPISettings) {}
    void endTransaction() {}
    uint8_t transfer(uint8_t data) { return data; }
    void transferBytes(const uint8_t *, uint8_t *, size_t) {}
};
inline SPIClass SPI;
