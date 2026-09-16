# E-Ink Display Firmware

Custom firmware for Seeed Studio XIAO ePaper Display Boards. This one PlatformIO
project holds three firmware images, selected by environment:

| Environment | Board | Display | Status |
|---|---|---|---|
| `ee02-13in3` | EE02 | 13.3" Spectra 6, 1600x1200, dual UC8179 controllers | Full product firmware (WiFi, Worker sync, BLE provisioning, OTA) |
| `ee04-7in3` | EE04 | 7.3" Six-Color, 800x480, single ED2208 controller | Full product firmware — same feature set as EE02, sharing its core logic |
| `ee04-7in3-bringup` | EE04 | same panel as above | Standalone display-driver bring-up only (test pattern, no WiFi/OTA) — see below |

`ee02-13in3` and `ee04-7in3` share almost all of their non-display logic (WiFi,
HMAC request signing, device-config sync, OTA download/flash, schedule math,
deep sleep) via `lib/common/` — see "Shared Firmware Core" below. Each board's
own `src/<board>/` subdirectory holds only what's genuinely different: pins,
the display driver, buffer geometry, and the config-mode screen layout.
Environments compile only their own subdirectory (PlatformIO's
`build_src_filter`, since `src_dir` itself can't be set per-environment — see
`platformio.ini`'s comments). `pio run` with no `-e` builds all three; most
commands below need `-e <environment>` to target one.

Most of this document (Quick Start through OTA) applies to **both**
`ee02-13in3` and `ee04-7in3` identically, since they share the same core app —
examples use EE02, but the same steps work for EE04. See "EE04 Display
Bring-Up" near the end for the standalone `ee04-7in3-bringup` environment,
which predates and is unrelated to `ee04-7in3`'s normal operation.

## Features

- Fetches images from a configurable HTTP server
- **Hash-based change detection** - only downloads and refreshes when the image changes
- Deep sleep between refreshes for battery conservation
- Runtime configuration via Bluetooth LE (no reflashing needed)
- OTA firmware updates, per board (see "OTA Firmware Updates" below)
- Both panels use the same 6-color codes (Black, White, Yellow, Red, Blue, Green) — see "Color Codes" below

## Prerequisites

- [PlatformIO](https://platformio.org/) (CLI or VSCode extension)
- USB-C cable with data lines (not charge-only)
- A deployed Cloudflare Worker backend (see the repository root `README.md`'s "Deploy the Cloudflare Worker" step) — or `npm run dev` inside `worker/` for local development

## Quick Start

WiFi credentials aren't compiled into the firmware — `config.h` only holds pin
definitions and non-secret defaults, so there's nothing to edit or copy before
your first build. WiFi is provisioned after flashing, over Bluetooth (see
"Changing Configuration at Runtime" below).

### 1. Set Default Server Address (Optional)

Edit `lib/common/config_manager.h` (shared by every board) to point the compiled-in default at your own deployed Worker (these are only the *fallback* values — Bluetooth provisioning in step 4 below overrides them at runtime, so this step can be skipped entirely):

```cpp
#define DEFAULT_SERVER_HOST "eink.example.workers.dev"  // Your Worker's hostname
#define DEFAULT_SERVER_PORT 443
#define DEFAULT_USE_HTTPS true
#define DEFAULT_IMAGE_ENDPOINT "/image_packed"
#define DEFAULT_SLEEP_MINUTES 60
#define DEFAULT_ACTIVE_START_HOUR 8
#define DEFAULT_ACTIVE_END_HOUR 20
#define DEFAULT_TIMEZONE_OFFSET_MINUTES 0
```

### 2. Build the Firmware

```bash
cd firmware
pio run -e ee02-13in3   # or -e ee04-7in3, depending on your board
```

### 3. Flash the Firmware

Connect the board via USB. If the device is in deep sleep, press the reset button to wake it.

```bash
pio run -e ee02-13in3 -t upload --upload-port /dev/ttyACM0   # or -e ee04-7in3
```

**Note:** The USB port may vary. On Linux it's typically `/dev/ttyACM0`, on macOS `/dev/cu.usbmodem*`, on Windows `COM3` or similar.

If the device isn't detected, try a different USB cable - many cables are charge-only and lack data lines.

### 4. Provision WiFi

A freshly flashed device has no WiFi credentials, so it boots straight into
Bluetooth configuration mode — see "Changing Configuration at Runtime" below to
pair with it from `/provision` and set your WiFi network and server address.

### 5. Register the Device and Upload Images

An unregistered board's display shows a QR code with its MAC address instead of your photos. Scan it (or open `/admin?claim=<mac>` on your Worker) to claim the device into your account, then upload images from `/admin`. See the repository root `README.md` for the full walkthrough. The Worker exposes these device-facing endpoints (see `worker/openapi.yaml` for the complete API):
- `/device_config` - Current epoch time plus resolved schedule/firmware target
- `/image_packed` - 960KB binary data for the display
- `/hash` - 16-character hash for change detection
- `/firmware_bin` - OTA firmware binary download
- `/crash_report` - Crash/rollback reporting

### 6. Test

Press the reset button on the board. Once WiFi is provisioned, the display should:
1. Connect to WiFi
2. Sync current time and optional schedule overrides from `/device_config`
3. Skip work and go back to sleep if it is currently in quiet hours
4. Check the image hash
5. Download the image (if changed)
6. Refresh the display (takes 20-30 seconds)
7. Enter deep sleep

## Monitoring Serial Output

The firmware outputs debug information via USB serial at 115200 baud.

### Using `cat` (simplest)

```bash
# Set baud rate and read output
stty -F /dev/ttyACM0 115200 raw -echo
cat /dev/ttyACM0
```

### Using `screen`

```bash
screen /dev/ttyACM0 115200
# Press Ctrl+A then K to exit
```

### Using PlatformIO Monitor

```bash
pio device monitor --port /dev/ttyACM0 --baud 115200
```

### Important: Deep Sleep Disconnects USB

When the ESP32-S3 enters deep sleep, the USB connection is lost. This is normal behavior. To see output:

1. Start your serial monitor
2. Press the reset button on the board
3. Output will appear as the device boots

If you want the monitor to reconnect automatically after each sleep cycle:

```bash
while true; do
  pio device monitor --port /dev/ttyACM0 --baud 115200
  sleep 1
done
```

### Example Output

```
========================================
Seeed EE02 E-Ink Display Firmware
========================================
Boot count: 1
Wakeup was not from deep sleep (code: 0)
ConfigManager: Initialized
Current Configuration:
  Server: your-worker.workers.dev:443 (HTTPS)
  Endpoint: /image_packed
  Full URL: https://your-worker.workers.dev/image_packed
  Refresh interval: 15 minutes
  Active window: 08:00-20:00
  Timezone offset: 0 minutes from UTC

========================================
NORMAL OPERATION MODE
========================================

Connecting to WiFi: YourNetwork
.
Connected! IP: 192.168.86.24
Fetching device config from: https://your-worker.workers.dev/device_config
Clock synchronized from server epoch: 1772290800
Clock status: utc=1772290800, local=08:00, active_window=yes
Checking image hash at: https://your-worker.workers.dev/hash
Last known hash: (none)
Server hash: 942d3cfc05c8fa41
Image changed - will download new image
Spectra6: Initializing display...
Spectra6: Buffer allocated in PSRAM (960000 bytes)
Fetching image from: https://your-worker.workers.dev/image_packed
Content length: 960000 bytes
Downloaded 960000 bytes in 10395 ms
Spectra6: Starting display refresh...
Spectra6: Data transfer complete in 3405 ms
Spectra6: Sending refresh command (this takes 20-30 seconds)...
Spectra6: Refresh complete in 28432 ms
WiFi disconnected
Entering deep sleep for 15 minutes 0 seconds...
Going to sleep now...
```

When the image hasn't changed:
```
Checking image hash at: https://your-worker.workers.dev/hash
Last known hash: 942d3cfc05c8fa41
Server hash: 942d3cfc05c8fa41
Image unchanged - skipping download
Image unchanged - going back to sleep
WiFi disconnected
Entering deep sleep for 15 minutes 0 seconds...
```

When the device wakes during quiet hours:
```
Fetching device config from: https://your-worker.workers.dev/device_config
Clock synchronized from server epoch: 1772337600
Clock status: utc=1772337600, local=21:00, active_window=no
Currently in quiet hours - skipping hash/image fetch
WiFi disconnected
Outside active window - sleeping until next active start in 39600 seconds
Entering deep sleep for 660 minutes 0 seconds...
```

## Changing Configuration at Runtime

The firmware supports runtime configuration without reflashing, including WiFi
credentials — provisioning happens over Bluetooth LE, not a device-hosted web
server (there's no AP mode / captive portal / IP address to visit anymore).

### Entering Configuration Mode

**Hold Button 1 during reset:**
1. Hold Button 1 (GPIO2)
2. While holding, press and release the reset button
3. Continue holding Button 1 for an additional second
4. Release Button 1

A device that has never been provisioned (no WiFi credentials saved yet) enters
configuration mode automatically on boot — no button needed for first-time setup.

Either way, the device starts advertising over Bluetooth as `EInk-Setup`.

### Bluetooth Configuration Interface

1. From Chrome or Edge (desktop or Android — Web Bluetooth isn't supported in
   Safari/iOS), open the worker's `/provision` page (linked from its home page).
2. Click "Connect to device" and select `EInk-Setup` from the browser's picker.
3. Configure WiFi (use "Scan" to list nearby networks) plus:
   - **Server Host**: your Worker's hostname (e.g., `eink.example.workers.dev`)
   - **Server Port**, **Use HTTPS**, **Image Endpoint**
   - **Refresh Interval**: Minutes between wakeups during active hours (1-1440)
   - **Active Start/End Hour**: Local hours bounding the active window (0-23)
   - **Timezone Offset**: Minutes from UTC used for local wall-clock scheduling
4. Click "Save & Reboot". The device saves to NVS and restarts into normal
   operation, connecting to the WiFi network you just gave it.

### Configuration Persistence

Settings — including WiFi credentials — are stored in NVS (Non-Volatile Storage)
and persist across reboots, deep sleep cycles, power loss, and OTA firmware
updates (NVS is a separate flash partition from the app image, so an update can
never overwrite them).

### Remote Schedule Overrides

The Worker can override a device's local schedule — set this from `/admin`'s schedule editor (backed by `PUT /admin/schedule/{mac}`, one override per device MAC; there's no shared "all devices" tier).

```json
{
  "refresh_interval_minutes": 60,
  "active_start_hour": 8,
  "active_end_hour": 20,
  "timezone_offset_minutes": -480
}
```

Only the keys you include are overridden; clearing the override (`DELETE /admin/schedule/{mac}`) falls back to the device's locally stored configuration from Bluetooth provisioning.

## Troubleshooting

### Device not detected via USB

1. **Try a different USB cable** - Many cables are charge-only
2. Check if device appears: `ls /dev/ttyACM*` (Linux) or `ls /dev/cu.usb*` (macOS)
3. The device may be in deep sleep - press reset to wake it

### WiFi connection fails

- Re-enter Bluetooth config mode (hold Button 1 during reset) and re-provision the
  SSID/password from `/provision` — WiFi credentials live in NVS, not `config.h`
- Check that your network is 2.4GHz (ESP32 doesn't support 5GHz)

### HTTP requests fail (code: -1)

- Verify the Worker is reachable: `curl https://your-worker.workers.dev/`
- Check the server host/port/HTTPS settings saved during Bluetooth provisioning
- If pointed at a local `wrangler dev` server instead of a deployed Worker, confirm **Use HTTPS** is unchecked and the board is on the same network as your dev machine

### Display doesn't refresh

- Check serial output for errors
- Verify the Worker is returning valid data: `curl -H "X-Device-MAC: <your-mac>" https://your-worker.workers.dev/hash`
- The refresh takes 20-30 seconds

### Image appears rotated

Images are EXIF-corrected and dithered server-side on upload (see `worker/src/lib/decode.ts` and `dither.ts`). Re-upload the source photo from `/admin` if its orientation looks wrong.

## Shared Firmware Core

`lib/common/` holds everything genuinely board-agnostic, automatically on
every environment's include path (PlatformIO's `lib_dir` is project-global,
unlike `src_dir`):

- `config_manager.h/.cpp` — NVS-backed WiFi/server/schedule storage
- `ble_provisioning.h/.cpp` — the Bluetooth LE GATT provisioning server
- `ota_health.h/.cpp` — bootloader-rollback + crash-report safety net
- `version.h` — **one shared `FIRMWARE_VERSION`** for every board (not one
  per board) — see "OTA Firmware Updates" below for why
- `device_app.h` — the actual app logic: WiFi connect/reconnect, HMAC
  request signing, `/device_config` sync, image fetch with hash-check,
  firmware OTA download/verify/flash, schedule/quiet-hours math, deep sleep.
  Templated on the board's `Display` type (`template<typename DisplayT>`,
  not a virtual interface — each environment only ever instantiates its own
  board's specialization, so there's no vtable/flash cost) since
  `Spectra6Display` and `SixColor73Display` already expose the identical
  public surface (`begin()/loadImageData()/refresh()/clear()/drawString()/
  sleep()/getBuffer()/getBufferSize()`).

Each board's own `src/<board>/` holds only what's genuinely different: pins
(`config.h`, including a `BOARD_ID` macro — see "OTA Firmware Updates"),
the display driver, and the config-mode screen layout (`showConfigModeScreen()`
in `main.cpp` — different pixel coordinates per panel resolution, not worth
abstracting for ~15 lines of glue). Each board's `main.cpp` is ~150 lines of
wiring: instantiate `Display`/`ConfigManager`/`BLEProvisioning`/`OtaHealth`,
declare the `RTC_DATA_ATTR` wake-cycle state, handle config-mode entry, then
call into `DeviceApp::runNormalMode()`.

**Important for anyone editing `device_app.h`:** it relies on the including
`main.cpp` having already `#include`d that board's own `config.h` first (for
`BOARD_ID`, pin macros, buffer-size constants, and the optional `PIN_POWER`
`#ifdef`) — it deliberately does not `#include "config.h"` itself, since a
quote-include from `lib/common/` wouldn't reliably resolve to a specific
board's `src/<board>/config.h`.

## Device Simulator

`firmware/simulator/` (`make BOARD=ee02|ee04`) is a native Mac build of this
*same* codebase — `lib/common/*.cpp` and the chosen board's `display.cpp`/
`main.cpp` compiled directly, unmodified, against Arduino/ESP32/NimBLE stub
headers, SDL2-windowed. It's a real way to exercise provisioning (via the
real `/provision` page, bridged over HTTP instead of Web Bluetooth), the
image-fetch/dithering flow, and the EE04 image-geometry gap below, against a
**local** `wrangler dev` — see `firmware/simulator/README.md` for setup,
flags, and how the BLE bridge works.

## File Structure

```
firmware/
├── platformio.ini          # Three environments: ee02-13in3, ee04-7in3, ee04-7in3-bringup
├── README.md                # This file
├── simulator/                # Native SDL2 build of this same codebase - see its own README.md
│   ├── Makefile
│   ├── main_native.cpp
│   ├── gatt_bridge.h/.cpp    # BLE-over-HTTP bridge for ble_provisioning.cpp
│   ├── display_render.h/.cpp # packed-buffer -> SDL window
│   ├── stubs/                 # Arduino/ESP32/NimBLE API stand-ins
│   └── vendor/ArduinoJson/    # vendored, unmodified
├── lib/
│   └── common/               # Shared across every board — see "Shared Firmware Core" above
│       ├── config_manager.h/.cpp
│       ├── ble_provisioning.h/.cpp
│       ├── ota_health.h/.cpp
│       ├── version.h
│       └── device_app.h
└── src/
    ├── ee02/
    │   ├── config.h              # Pin definitions, BOARD_ID, non-secret defaults
    │   ├── display.h              # Spectra 6 display driver interface
    │   ├── display.cpp            # Spectra 6 display driver
    │   └── main.cpp                # Board-specific wiring + config-mode screen
    └── ee04/
        ├── config.h               # Pin definitions, BOARD_ID, display dimensions
        ├── display.h              # Six-Color 7.3" display driver interface
        ├── display.cpp            # Six-Color 7.3" display driver (ED2208)
        └── main.cpp                # #ifdef EE04_BRINGUP_TEST_MODE splits between
                                     # the standalone bring-up sketch (ee04-7in3-bringup)
                                     # and the full app wiring (ee04-7in3)
```

## Hardware Reference

### Pin Configuration (EE02 Board)

| Function | GPIO | Notes |
|----------|------|-------|
| SPI CLK | 7 | Shared by both controllers |
| SPI MOSI | 9 | Shared by both controllers |
| CS Master | 44 | Top half of display (rows 0-599) |
| CS Slave | 41 | Bottom half of display (rows 600-1199) |
| DC | 10 | Data/Command select |
| Reset | 38 | Hardware reset |
| Busy | 4 | LOW when busy, HIGH when ready |
| Power | 43 | Display power control |

### Display Specifications

- Resolution: 1600 x 1200 pixels
- Colors: 6 (Black, White, Yellow, Red, Blue, Green)
- Data format: 4-bit per pixel (2 pixels per byte)
- Buffer size: 960,000 bytes
- Refresh time: 20-30 seconds

### Color Codes

| Color | Hardware Code |
|-------|---------------|
| Black | 0x00 |
| White | 0x01 |
| Yellow | 0x02 |
| Red | 0x03 |
| Blue | 0x05 |
| Green | 0x06 |

## OTA Firmware Updates

Once a device is running and configured to point at the Cloudflare Worker, further
firmware updates don't require USB at all. See CLAUDE.md's "OTA Firmware Updates"
section for the full flow; the short version:

1. Bump `FIRMWARE_VERSION` in `lib/common/version.h` — **shared by both boards**,
   not one version number per board, so one tag releases both binaries together.
2. `git tag vX.Y.Z && git push mine vX.Y.Z` (must match, with a leading `v`).
3. GitHub Actions builds **both** `ee02-13in3` and `ee04-7in3` and attaches
   `firmware-ee02-13in3.bin` and `firmware-ee04-7in3.bin` — distinct assets on
   the same release — automatically. (`ee04-7in3-bringup` is never built by
   this workflow — it's a standalone manual-use environment, not a release
   target.)
4. In the Worker's `/admin` page's Firmware panel, sync the release (or wait
   up to 6h for the automatic sync). There's no picking a specific version —
   each device is set to either the `stable` channel (always tracks whatever
   was most recently synced for its own board — resolved from its
   self-reported `X-Device-Board`, so a device can't end up on the wrong
   board's binary) or `beta` (a no-op for now; no beta pipeline exists yet).
5. Set a device's channel — there's no shared "every device" target, so each
   MAC is opted in individually, and clearing a device's channel leaves it on
   whatever it's already running. Note that unlike picking exact versions,
   every `stable` device on a board moves to a newly-synced release together
   — there's no staged/one-at-a-time rollout anymore, and a bad release isn't
   automatically rolled back if it boots but misbehaves (see CLAUDE.md's
   "Safety model" for what *is* covered).

Each board's compiled-in `BOARD_ID` (`config.h`) is sent as `X-Device-Board` on
every request (see `lib/common/device_app.h`'s `addCommonHeaders()`) — this is
the same string as the PlatformIO environment name and the GitHub release
asset suffix, so it's one board-id vocabulary end to end: firmware build →
release asset name → `devices.board` → `firmware_releases.board`.

## EE04 Display Bring-Up (`ee04-7in3-bringup`)

Standalone hardware bring-up firmware for the EE04 board + 7.3" Six-Color
800x480 panel (single ED2208 controller) — a separate PlatformIO environment
from `ee04-7in3`'s normal operation, built from the same `src/ee04/main.cpp`
under an `#ifdef EE04_BRINGUP_TEST_MODE` (set via this environment's
`build_flags`). No WiFi, no Worker calls, no BLE, no OTA, no deep-sleep
cycling, no battery read — it just boots once, draws a test pattern, and
refreshes the panel. This is what originally de-risked the hardware/driver
unknowns (pin mapping, busy-pin polarity, register sequence, color codes)
before the full app existed, and stays available for the same purpose if
hardware issues resurface later — e.g. after a display-driver change, or on
a newly-acquired EE04 unit whose wiring hasn't been verified yet.

### Build and flash

```bash
cd firmware
pio run -e ee04-7in3-bringup -t upload --upload-port /dev/ttyACM0
pio device monitor --port /dev/ttyACM0 --baud 115200
```

### Pin mapping (unverified — see checklist below)

Derived from Seeed's `Seeed_GFX` library (`Setup509_Seeed_XIAO_EPaper_7inch3_colorful.h`,
combo 509, `ED2208_DRIVER`), with D-pin aliases resolved against the same XIAO
ESP32-S3 mapping EE02 uses. SCLK/MOSI/DC/RESET/BUSY resolve to the exact same
GPIO numbers as EE02, and CS matches EE02's *master* CS — consistent with both
boards sharing one XIAO shield header layout on different carrier PCBs, but
**not confirmed by measurement on real hardware**.

| Function | GPIO | Notes |
|---|---|---|
| SPI CLK | 7 | |
| SPI MOSI | 9 | |
| CS | 44 | Single controller — no master/slave split |
| DC | 10 | |
| Reset | 38 | |
| Busy | 4 | Polarity **flipped vs. EE02** — see checklist step 2 |

No display-power-enable pin is documented for EE04 (unlike EE02's GPIO43);
treat as not needed until bring-up shows otherwise.

### Bring-up verification checklist

Work through these in order — each step isolates one variable before moving on:

1. **Confirm the borrowed EE02 pin map before trusting it.** Toggle
   `PIN_RESET`/`PIN_DC`/`PIN_CS` and watch `PIN_BUSY` (multimeter, logic
   analyzer, or just whether `waitUntilIdle()` ever returns after the first
   reset) before debugging anything else. If BUSY never changes at all,
   suspect the pin mapping itself first.
2. **Determine BUSY polarity empirically.** Log `digitalRead(PIN_BUSY)`
   every ~50ms for a couple seconds after reset instead of blocking, to see
   whether it idles HIGH (as `display.cpp`'s current assumption has it) or
   LOW (EE02's convention). Flip the comparison in `waitUntilIdle()` if
   wrong — keep the timeout in place while iterating so a wrong guess logs
   a timeout instead of hanging the board.
3. **Solid white fill only.** Comment `main.cpp`'s `drawColorBars()` call
   down to just `display.clear(SixColor73::WHITE);` before refreshing.
   Confirms SPI wiring, the init sequence, and the refresh/busy handshake
   independent of buffer content.
4. **Solid black fill.** Same, with `SixColor73::BLACK`. Confirms
   color-code-to-visual mapping at both extremes.
5. **Full six-color bar test + text label** (the default `main.cpp`
   behavior). Verify each bar shows the *correct* color in the *correct*
   position (validates the reused wire codes), and the `drawString()` text
   is legible and right-side-up (validates row-major, non-transposed
   buffer layout end-to-end).
6. **If garbled / split / wrong aspect ratio**: suspect the TRES byte
   order in `display.cpp`'s `initializeDisplay()` (try
   `{0x01,0xE0,0x03,0x20}` instead of `{0x03,0x20,0x01,0xE0}`) or a
   `DISPLAY_WIDTH`/`DISPLAY_HEIGHT` mismatch in `config.h`.
7. **If mirrored**: this driver has no mirror step (ED2208's rotation hook
   is a no-op in Seeed's reference library); add a row/column reversal to
   `transferData()` only if bring-up actually shows it's needed.
8. **If `waitUntilIdle()` times out mid-init**: try inserting small
   (~10ms) inter-command delays between `initializeDisplay()`'s
   `sendCommandData()` calls, matching EE02's pattern — the transcribed
   ED2208 sequence currently has none.
9. **Once color bars + text render correctly across a few power cycles**,
   bring-up is done — update the pin table and busy polarity above (and the
   comments in `config.h`/`display.cpp`) to record what was actually
   verified. `ee04-7in3` (the full app, sharing `lib/common/` with EE02 —
   WiFi, Worker sync, BLE provisioning, OTA, deep sleep, battery) already
   exists and builds on the same verified driver; flash that environment
   next to confirm the full product firmware behaves correctly end to end.

## Power Consumption

- **Active (WiFi + display refresh)**: ~150-200mA
- **Deep sleep**: ~10µA

For battery operation, increase the sleep interval to maximize battery life. At 15-minute intervals, the device is active for roughly 1 minute per hour.

## Credits

- EE02 display driver based on [esphome-bigink](https://github.com/acegallagher/esphome-bigink)
- EE04 display driver ported from Seeed's [Seeed_GFX](https://github.com/Seeed-Studio/Seeed_GFX) library's ED2208 driver profile
- Image processing based on the GooDisplay project in `~/eink`
