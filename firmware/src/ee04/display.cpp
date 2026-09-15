#include "display.h"

// Initialization data ported from Seeed_GFX's TFT_Drivers/ED2208_Init.h —
// see firmware/README.md's bring-up notes for the full register table.

static const uint8_t CMDH_DATA[] = {0x49, 0x55, 0x20, 0x08, 0x09, 0x18};
static const uint8_t PWRR_DATA[] = {0x3F, 0x00, 0x32, 0x2A, 0x0E, 0x2A};
static const uint8_t PSR_DATA[]  = {0x5F, 0x69};
static const uint8_t POFS_DATA[] = {0x00, 0x54, 0x00, 0x44};
static const uint8_t BTST1_DATA[] = {0x40, 0x1F, 0x1F, 0x2C};
static const uint8_t BTST2_DATA[] = {0x6F, 0x1F, 0x16, 0x25};
static const uint8_t BTST3_DATA[] = {0x6F, 0x1F, 0x1F, 0x22};
static const uint8_t IPC_DATA[]  = {0x00, 0x04};
static const uint8_t PLL_DATA[]  = {0x02};
static const uint8_t TSE_DATA[]  = {0x00};
static const uint8_t CDI_DATA[]  = {0x3F};
static const uint8_t TCON_DATA[] = {0x02, 0x00};
static const uint8_t TRES_DATA[] = {
    (DISPLAY_WIDTH >> 8) & 0xFF, DISPLAY_WIDTH & 0xFF,
    (DISPLAY_HEIGHT >> 8) & 0xFF, DISPLAY_HEIGHT & 0xFF
};
static const uint8_t VDCS_DATA[]   = {0x1E};
static const uint8_t T_VDCS_DATA[] = {0x01};
static const uint8_t AGID_DATA[]   = {0x00};
static const uint8_t PWS_DATA[]    = {0x2F};
static const uint8_t CCSET_DATA[]  = {0x00};
static const uint8_t TSSET_DATA[]  = {0x00};

SixColor73Display::SixColor73Display()
    : spiInitialized_(false) {
}

bool SixColor73Display::begin() {
    Serial.println("SixColor73: Initializing display...");

    memset(buffer_, 0x11, BUFFER_SIZE);  // 0x11 = two white pixels

    pinMode(PIN_CS, OUTPUT);
    digitalWrite(PIN_CS, HIGH);

    pinMode(PIN_DC, OUTPUT);
    digitalWrite(PIN_DC, LOW);

    pinMode(PIN_RESET, OUTPUT);
    digitalWrite(PIN_RESET, HIGH);

    pinMode(PIN_BUSY, INPUT);

    Serial.println("SixColor73: GPIO configured");

    hardwareReset();
    initializeDisplay();

    Serial.println("SixColor73: Display initialized successfully");
    return true;
}

void SixColor73Display::loadImageData(const uint8_t* data, size_t length) {
    if (data == nullptr) return;

    size_t copyLen = (length > BUFFER_SIZE) ? BUFFER_SIZE : length;
    memcpy(buffer_, data, copyLen);
    Serial.printf("SixColor73: Loaded %d bytes of image data\n", copyLen);
}

void SixColor73Display::refresh() {
    Serial.println("SixColor73: Starting display refresh...");
    uint32_t startTime = millis();

    transferData();
    refreshScreen();
    powerOff();

    Serial.printf("SixColor73: Refresh complete in %lu ms\n", millis() - startTime);
}

void SixColor73Display::fillColor(uint8_t color) {
    uint8_t byteVal = (color << 4) | color;
    memset(buffer_, byteVal, BUFFER_SIZE);
}

void SixColor73Display::clear(uint8_t color) {
    fillColor(color);
}

// ============================================================================
// Text rendering — ported near-verbatim from firmware/src/ee02/display.cpp.
// Buffer/color-index-agnostic (works purely through setPixel()), so it needs
// no changes beyond picking up this board's DISPLAY_WIDTH/HEIGHT/BUFFER_SIZE.
// ============================================================================
//
// Minimal built-in 5x7 bitmap font covering ' ', '-', '.', '/', ':', '0'-'9',
// 'A'-'Z' (everything else renders as a blank cell). Indexed by (char - 0x20);
// each glyph is 7 rows of 5 bits (bit4 = leftmost pixel).

static const uint8_t FONT_5X7[][7] = {
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

uint8_t SixColor73Display::getPixel(uint16_t x, uint16_t y) {
    size_t byteIdx = ((size_t)y * DISPLAY_WIDTH + x) / 2;
    uint8_t b = buffer_[byteIdx];
    return (x & 1) ? (b & 0x0F) : ((b >> 4) & 0x0F);
}

void SixColor73Display::setPixel(uint16_t x, uint16_t y, uint8_t color) {
    if (x >= DISPLAY_WIDTH || y >= DISPLAY_HEIGHT) return;
    size_t byteIdx = ((size_t)y * DISPLAY_WIDTH + x) / 2;
    uint8_t existing = buffer_[byteIdx];
    if (x & 1) {
        buffer_[byteIdx] = (existing & 0xF0) | (color & 0x0F);
    } else {
        buffer_[byteIdx] = (existing & 0x0F) | ((color & 0x0F) << 4);
    }
}

void SixColor73Display::drawChar(uint16_t x, uint16_t y, char c, uint8_t color, uint8_t scale) {
    if (c < 0x20 || c > 0x5A) c = ' ';
    const uint8_t* glyph = FONT_5X7[c - 0x20];

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

void SixColor73Display::drawString(uint16_t x, uint16_t y, const String& text, uint8_t color, uint8_t scale) {
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

void SixColor73Display::sleep() {
    powerOff();
}

// ============================================================================
// Hardware Control
// ============================================================================

void SixColor73Display::hardwareReset() {
    Serial.println("SixColor73: Hardware reset");
    digitalWrite(PIN_RESET, LOW);
    delay(RESET_SETTLE_MS);
    digitalWrite(PIN_RESET, HIGH);
    delay(10);
    waitUntilIdle(BUSY_INIT_TIMEOUT_MS);
}

bool SixColor73Display::waitUntilIdle(uint32_t timeoutMs) {
    uint32_t start = millis();
    // ED2208's reference macro (Seeed_GFX's CHECK_BUSY()) treats HIGH as
    // idle/ready — the OPPOSITE of EE02/UC8179's "HIGH = busy" convention.
    // UNVERIFIED on real hardware — flip this comparison if bring-up hangs
    // here (see firmware/README.md's bring-up checklist, step 2).
    while (digitalRead(PIN_BUSY) == LOW) {
        delay(10);
        if (millis() - start > timeoutMs) {
            Serial.println("SixColor73: Wait timeout");
            return false;
        }
    }
    return true;
}

// ============================================================================
// SPI Operations
// ============================================================================

void SixColor73Display::spiBegin() {
    if (!spiInitialized_) {
        SPI.begin(PIN_SPI_CLK, -1, PIN_SPI_MOSI, -1);
        spiInitialized_ = true;
    }
    SPI.beginTransaction(SPISettings(SPI_CLOCK_HZ, MSBFIRST, SPI_MODE0));
}

void SixColor73Display::spiEnd() {
    SPI.endTransaction();
}

void SixColor73Display::spiWriteByte(uint8_t data) {
    SPI.transfer(data);
}

void SixColor73Display::spiWriteArray(const uint8_t* data, size_t len) {
    SPI.transferBytes(data, nullptr, len);
}

// ============================================================================
// Single-Controller Commands
// ============================================================================

void SixColor73Display::sendCommand(uint8_t cmd) {
    digitalWrite(PIN_DC, LOW);
    spiBegin();
    digitalWrite(PIN_CS, LOW);
    spiWriteByte(cmd);
    digitalWrite(PIN_CS, HIGH);
    spiEnd();
}

void SixColor73Display::sendCommandData(uint8_t cmd, const uint8_t* data, size_t len) {
    digitalWrite(PIN_DC, LOW);
    spiBegin();
    digitalWrite(PIN_CS, LOW);
    spiWriteByte(cmd);
    if (len > 0 && data != nullptr) {
        digitalWrite(PIN_DC, HIGH);
        spiWriteArray(data, len);
    }
    digitalWrite(PIN_CS, HIGH);
    spiEnd();
}

// ============================================================================
// Initialization Sequence — ported from Seeed_GFX's TFT_Drivers/ED2208_Init.h.
// No inter-command delays in that source macro (unlike EE02's driver, which
// sprinkles 10ms delays between dual-CS commands) — start delay-free, add
// small delays only if bring-up proves unreliable (see README).
// ============================================================================

void SixColor73Display::initializeDisplay() {
    Serial.println("SixColor73: Running initialization sequence...");

    sendCommandData(0xAA, CMDH_DATA, sizeof(CMDH_DATA));
    sendCommandData(0x01, PWRR_DATA, sizeof(PWRR_DATA));
    sendCommandData(0x00, PSR_DATA, sizeof(PSR_DATA));
    sendCommandData(0x03, POFS_DATA, sizeof(POFS_DATA));
    sendCommandData(0x05, BTST1_DATA, sizeof(BTST1_DATA));
    sendCommandData(0x06, BTST2_DATA, sizeof(BTST2_DATA));
    sendCommandData(0x08, BTST3_DATA, sizeof(BTST3_DATA));
    sendCommandData(0x13, IPC_DATA, sizeof(IPC_DATA));
    sendCommandData(0x30, PLL_DATA, sizeof(PLL_DATA));
    sendCommandData(0x41, TSE_DATA, sizeof(TSE_DATA));
    sendCommandData(0x50, CDI_DATA, sizeof(CDI_DATA));
    sendCommandData(0x60, TCON_DATA, sizeof(TCON_DATA));
    sendCommandData(0x61, TRES_DATA, sizeof(TRES_DATA));
    sendCommandData(0x82, VDCS_DATA, sizeof(VDCS_DATA));
    sendCommandData(0x84, T_VDCS_DATA, sizeof(T_VDCS_DATA));
    sendCommandData(0x86, AGID_DATA, sizeof(AGID_DATA));
    sendCommandData(0xE3, PWS_DATA, sizeof(PWS_DATA));
    sendCommandData(0xE0, CCSET_DATA, sizeof(CCSET_DATA));
    sendCommandData(0xE6, TSSET_DATA, sizeof(TSSET_DATA));

    sendCommand(0x04);  // Power on
    waitUntilIdle(BUSY_POWERON_TIMEOUT_MS);

    Serial.println("SixColor73: Initialization complete");
}

// ============================================================================
// Data Transfer — straight row-major push, no transpose (unlike EE02/UC8179,
// where the panel's scan direction across two controllers forces a
// pixel-by-pixel transpose loop). setPixel()/loadImageData() already store
// data row-major, 2px/byte, matching this panel's native scan order, so the
// whole buffer can go out in a single SPI burst.
// ============================================================================

void SixColor73Display::transferData() {
    Serial.println("SixColor73: Starting data transfer...");
    uint32_t start = millis();

    digitalWrite(PIN_DC, LOW);
    spiBegin();
    digitalWrite(PIN_CS, LOW);
    spiWriteByte(0x10);  // DTM — start data transmission
    digitalWrite(PIN_DC, HIGH);
    spiWriteArray(buffer_, BUFFER_SIZE);
    digitalWrite(PIN_CS, HIGH);
    spiEnd();

    Serial.printf("SixColor73: Data transfer complete in %lu ms\n", millis() - start);
}

// ============================================================================
// Refresh Sequence
// ============================================================================

void SixColor73Display::refreshScreen() {
    Serial.println("SixColor73: Sending refresh command...");
    uint8_t data = 0x00;
    sendCommandData(0x12, &data, 1);

    uint32_t refreshStart = millis();
    if (!waitUntilIdle(BUSY_REFRESH_TIMEOUT_MS)) {
        Serial.println("SixColor73: Refresh timeout");
    } else {
        Serial.printf("SixColor73: Refresh complete in %lu ms\n", millis() - refreshStart);
    }
}

void SixColor73Display::powerOff() {
    Serial.println("SixColor73: Power off");
    uint8_t data = 0x00;
    sendCommandData(0x02, &data, 1);
    waitUntilIdle(BUSY_POWEROFF_TIMEOUT_MS);
}
