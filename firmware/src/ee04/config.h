#ifndef CONFIG_H
#define CONFIG_H

// Identifies this firmware build to the Worker (X-Device-Board header, see
// lib/common/device_app.h's addCommonHeaders()) and must exactly match the
// PlatformIO environment name and the GitHub release asset suffix
// (firmware-ee04-7in3.bin) — one board-id vocabulary used everywhere.
#define BOARD_ID "ee04-7in3"

// Display Pin Configuration (EE04 board)
//
// NOT yet hardware-verified on a real EE04 unit. These numbers come from
// Seeed's Seeed_GFX library (Setup509_Seeed_XIAO_EPaper_7inch3_colorful.h,
// combo 509, ED2208_DRIVER), with its D-pin aliases resolved against the
// same XIAO ESP32-S3 mapping the EE02 firmware already uses (SCLK/MOSI/DC/
// RESET/BUSY all resolve to the exact same GPIO numbers as EE02's
// src/ee02/config.h, and CS matches EE02's *master* CS pin - consistent
// with both boards sharing one XIAO shield header layout on different
// carrier PCBs, but not confirmed by measurement). Verify via the bring-up
// checklist in firmware/README.md before trusting this, especially BUSY
// polarity (see display.cpp's waitUntilIdle()).
#define PIN_SPI_CLK     7     // D8
#define PIN_SPI_MOSI    9     // D10
// MISO (D9 / GPIO8) intentionally unused — the e-paper controller is write-only.
#define PIN_CS          44    // D7 — single ED2208 controller, no master/slave split
#define PIN_DC          10
#define PIN_RESET       38
#define PIN_BUSY        4     // D3 — polarity UNCONFIRMED, see display.cpp

// No PIN_POWER: Seeed's EE04 reference profile documents no display-power-enable
// pin (unlike EE02's PIN_POWER on GPIO43). Treat as not needed until bring-up
// shows otherwise.

// Button Pin Configuration (active LOW) — per CLAUDE.md, this is EE04's own
// documented layout (not borrowed from EE02 like the display pins above).
#define PIN_BUTTON_1    2     // Config mode: hold during boot to enter setup

// Battery ADC Configuration — same voltage divider circuit as EE02, which was
// itself copied from EE04's reference documentation, so these (unlike the
// display pins above) are the known-good values, not an inference.
#define PIN_BATTERY_ADC   1   // A0/GPIO1 - Battery voltage via voltage divider
#define PIN_ADC_ENABLE    6   // A5/GPIO6 - Enable the voltage divider circuit
#define BATTERY_SCALE     7.16  // Voltage divider scaling factor

// Display Dimensions
#define DISPLAY_WIDTH   800
#define DISPLAY_HEIGHT  480
#define BUFFER_SIZE     192000  // (800 * 480) / 2 bytes (4bpp)

// SPI
#define SPI_CLOCK_HZ    10000000  // 10 MHz, Mode 0 — same as EE02

// Display busy-wait timeouts
#define RESET_SETTLE_MS            20
#define BUSY_INIT_TIMEOUT_MS       2000
#define BUSY_POWERON_TIMEOUT_MS    5000
#define BUSY_REFRESH_TIMEOUT_MS    60000
#define BUSY_POWEROFF_TIMEOUT_MS   5000

// HTTP timeout for control requests like /hash and /device_config (in milliseconds)
#define HTTP_TIMEOUT_MS 30000

// How long to wait for /image_packed to start responding (in milliseconds).
#define IMAGE_INITIAL_RESPONSE_TIMEOUT_MS 60000

// How long to tolerate no incoming image bytes once the transfer is underway.
#define IMAGE_STALL_TIMEOUT_MS 20000

// WiFi connection timeout (in milliseconds)
#define WIFI_TIMEOUT_MS 30000

// How long to try a fast reconnect (cached channel/BSSID, no scan) before
// falling back to a normal full-scan connect (in milliseconds).
#define WIFI_FAST_RECONNECT_TIMEOUT_MS 5000

// CPU frequency used for the whole active window (WiFi/BT require >=80MHz).
// Lower than the 240MHz default to cut active-mode current draw.
#define ACTIVE_CPU_FREQ_MHZ 80

#endif // CONFIG_H
