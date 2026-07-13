Seeed studios makes a development board called the XIAO ePaper Display Board - EE02 that is designed to drive an e ink spectra 6 13.3 inch display.  The board is based on the ESP32-s3 chip and supports WiFi and Bluetooth connectivity.

The board is relatively new and there is limited documentation and community support available for it. However, Seeed Studio recently published this documentation: https://wiki.seeedstudio.com/getting_started_with_ee02/#getting-started-with-arduino

There is also a github repository that is trying to do the same thing we are in terms of directly addressing the EE02 XIAO ePaper Display Board at https://github.com/acegallagher/esphome-bigink.

Note that in this repository there is also documentation of the 13.3 inch spectra 6 driver: 13_3_E6_eInk_Display_module_Datasheet.pdf

Seeed provides a web app called the SenseCraft HMI platform to communicate with the e ink display. However. we don't want to go through the WebApp to display images, we want to directly hit the api endpoints that the custom firmware that we build in this repository supports.  If you look at the ~/eink repository on this computer, you will see that I have done something similar with the GooDisplay e ink driver board. We used the GooDisplay web app to reverse engineer the api endpoints and then wrote a python script to hit those endpoints directly but the GooDisplay web app was pretty simple.

This repository now contains custom firmware for the ESP32 on the EEO2 board that runs a web client that generates http requests to our custom image server to display images on the 13.3 inch spectra 6 display.  We also have the capability to put the ESP32 to sleep and have it wake up at intervals to update the display.  The ESP32 wakes up, connects to WiFi, makes a request to the image server to get the image to display, displays the image, and then goes back to sleep.  The image server rotates through the various images in folders that use the MAC address of the EEO@ board.  We can manage the images that each screen displays by adding or deleting images from that screen's image folder (named for its MAC address)

## Custom Firmware Implementation

We have implemented custom Arduino/PlatformIO firmware in the `firmware/` directory:

### Architecture

```
[Home Server]                    [EE02 Board]
image_server.py                  Arduino Firmware
      │                                │
      │ GET /image_packed              │
      │◄──────────────────────────────│ (wake from deep sleep)
      │                                │
      │ Returns packed binary          │
      │ (960KB, pre-dithered)          │
      │──────────────────────────────►│
      │                                │
      │                                │ Display image
      │                                │ (dual-controller SPI)
      │                                │
      │                                │ Deep sleep (15 min default)
      │                                ▼
```

### Display Hardware Details

The 13.3" Spectra 6 display uses dual UC8179 controllers in master/slave configuration:

- **Master (CS=GPIO44)**: Top 600 pixel rows (0-599)
- **Slave (CS=GPIO41)**: Bottom 600 pixel rows (600-1199)
- Both controllers share CLK (GPIO7) and MOSI (GPIO9)

**Other GPIO pins:**
- DC: GPIO10
- Reset: GPIO38
- Busy: GPIO4 (HIGH when busy)
- Power: GPIO43

**Battery monitoring pins (same circuit as EE04 board):**
- Battery ADC: GPIO1 (A0) - voltage divider output
- ADC Enable: GPIO6 (A5) - set HIGH to enable voltage divider, LOW to save power

**Data Format:**
- 4-bit per pixel (2 pixels per byte)
- Total buffer: 960,000 bytes
- Data is transposed during transfer: buffer columns become output rows

### Files

- `firmware/platformio.ini` - PlatformIO project configuration
- `firmware/src/config.h` - Pin definitions and non-secret defaults (no WiFi credentials — see below)
- `firmware/src/config_manager.h/.cpp` - Persistent configuration storage (NVS), including WiFi credentials
- `firmware/src/ble_provisioning.h/.cpp` - Bluetooth LE GATT configuration interface (NimBLE)
- `firmware/src/display.h/.cpp` - Spectra 6 display driver (ported from esphome-bigink)
- `firmware/src/main.cpp` - Main loop: WiFi, fetch, display, deep sleep, config mode
- `image_server.py` - Flask server with image rotation and `/image_packed` endpoint
- `.eink_rotation_state.json` - Persisted rotation state (auto-generated, gitignored)

### Runtime Configuration (Bluetooth Provisioning)

WiFi credentials and the server endpoint are both configurable at runtime without
reflashing, over Bluetooth LE — there is no AP-mode/captive-portal HTTP server on
the device anymore (that approach, and `config_server.h/.cpp`, were removed).

**To enter configuration mode:**
1. Hold Button 1 (GPIO2) during boot, or just power on a device that has never
   been provisioned (empty WiFi SSID auto-enters config mode).
2. The device advertises itself over Bluetooth as `EInk-Setup`.
3. From a Chrome/Edge browser (desktop or Android — Web Bluetooth isn't supported
   in Safari/iOS), open the worker's `/provision` page (linked from its home page)
   and click "Connect to device" to pair.

**Configurable settings:**
- WiFi SSID/password — stored in NVS via `ConfigManager::setWifiCredentials()`,
  deliberately **not** part of the firmware image, so an OTA update (see below)
  can never disconnect a device from its network by overwriting them.
- Server host, port, and HTTPS flag (HTTPS required for a Cloudflare Workers
  backend, unchecked for a plain-HTTP local dev server; uses
  `WiFiClientSecure::setInsecure()` — encrypts traffic but does not validate the
  server's certificate)
- Image endpoint path, refresh interval, active-hours window, timezone offset

All of this is exchanged as JSON over a custom GATT service
(`firmware/src/ble_provisioning.h` documents the exact characteristic schema);
the browser-side implementation is `worker/src/provision-ui.ts`. Characteristics
are plain (not encryption-required) — an earlier version required BLE bonding,
but Web Bluetooth has no API to trigger that pairing itself, so a browser
read/write against an encrypted characteristic with no existing bond just fails
("GATT operation not permitted"). So the WiFi password does cross the air in the
clear during the brief provisioning window (config mode only runs long enough to
provision, not indefinitely). Configuration is stored in NVS and persists across
reboots and OTA updates.

### Building and Flashing

1. Install PlatformIO (VSCode extension or CLI)
2. Optionally edit `firmware/src/config_manager.h` to change default server settings
3. Connect EE02 board via USB
4. Build and upload:
   ```bash
   cd firmware
   pio run -t upload
   ```
5. Provision WiFi over Bluetooth (see "Runtime Configuration" above) — a fresh
   flash has no WiFi credentials, so the device boots straight into config mode.

### Running the Image Server

1. Install dependencies: `uv sync`
2. Create the images directory structure (see Multi-Device Support below)
3. Run: `uv run python image_server.py`
4. Server listens on http://0.0.0.0:5000

**Endpoints:**
- `/image_packed` - Returns 960KB of pre-processed 4bpp binary data (advances to next image)
- `/hash` - Returns 16-char MD5 hash for change detection
- `/current` - Returns JSON with current rotation status (all devices or specific device)
- `/` - Index page with multi-device status overview

All endpoints accept the `X-Device-MAC` header to identify which device is making the request.
The firmware also sends an `X-Battery-Voltage` header with the current battery voltage (e.g., "3.85").

### Multi-Device Support

The server supports multiple EE02 boards, each with their own image rotation. Devices are identified by their MAC address (sent via `X-Device-MAC` HTTP header).

**Directory Structure:**
```
seeed_eink_board/
├── images/
│   ├── default/          # Fallback for unknown devices
│   │   ├── image1.jpg
│   │   └── image2.png
│   ├── d0cf1326f7e8/     # Device-specific (MAC without separators)
│   │   ├── photo1.jpg
│   │   └── photo2.heic
│   └── aabbccddeeff/     # Another device
│       └── ...
├── image_server.py
└── .eink_rotation_state.json  # Tracks state per-device
```

**How it works:**
1. Each ESP32 sends its MAC address (lowercase, no separators) via the `X-Device-MAC` header
2. The server looks for a directory named `images/<mac-address>/`
3. If not found, it falls back to `images/default/`
4. Each device maintains its own rotation state (current index, last returned image)

**Finding your device's MAC:**
- Enter configuration mode on the EE02 (hold Button 1 during reset)
- The configuration page shows the device's MAC address and IP
- Use this MAC address (without colons, lowercase) as the directory name

**State File Format:**
```json
{
  "d0cf1326f7e8": {
    "current_index": 3,
    "last_returned": "image.jpg"
  },
  "default": {
    "current_index": 0,
    "last_returned": "fallback.png"
  }
}
```

### Image Rotation

The server rotates through images in device-specific or default directories:

- **Supported formats:** `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.heic`, `.webp`
- **HEIC support:** Enabled via `pillow-heif` library (handles iPhone photos directly)
- **Rotation order:** Alphabetical by filename
- **Persistence:** Rotation state (per-device) saved to `.eink_rotation_state.json`
- **Symlinks:** Supported - can link to images stored elsewhere
- **Fallback:** If device directory doesn't exist, uses `images/default/`; if that's empty, falls back to `image.jpg` in repository root
- **Dynamic updates:** Directory is scanned on each request, so adding/removing images takes effect immediately

Each request to `/image_packed` advances to the next image in rotation for that specific device.

### Battery Monitoring

The EE02 board has a voltage divider circuit (same as the EE04 board) that allows reading battery voltage via ADC:

- **GPIO1 (A0):** Battery voltage ADC input (through voltage divider)
- **GPIO6 (A5):** ADC enable pin - must be set HIGH before reading
- **Scaling factor:** 7.16 (voltage divider ratio, from EE04 reference)
- **Note:** GPIO1 is NOT a button despite earlier assumptions. The three physical keys on the board are on GPIO2, GPIO3, and GPIO5 (matching EE04 layout).

The firmware reads battery voltage once per boot (before WiFi to avoid ADC noise) and sends it to the server via the `X-Battery-Voltage` HTTP header. The server logs voltage levels and displays them on the status page with color coding:
- **RED:** < 3.3V (low, charge soon)
- **YELLOW:** 3.3V - 3.7V (OK)
- **GREEN:** > 3.7V (good)

Typical LiPo voltage range: 3.0V (empty) to 4.2V (full). Readings above 4.2V indicate USB power.

### OTA Firmware Updates

Firmware updates are delivered over the same channel as images/config — the ESP32
already wakes, connects to WiFi, and talks to the Worker every cycle, so OTA piggybacks
on that instead of adding a separate update mechanism.

**Flow:**
1. Bump `FIRMWARE_VERSION` in `firmware/src/version.h`, commit, then `git tag vX.Y.Z`
   (matching, with a leading `v`) and push the tag.
2. `.github/workflows/release-firmware.yml` builds the firmware with PlatformIO and
   attaches `firmware.bin` to a new GitHub release.
3. The Cloudflare Worker catalogs new releases automatically (a `scheduled()` Cron
   Trigger polls the GitHub releases API every 6h — see `wrangler.toml`'s `[triggers]`
   and `worker/src/routes/admin/firmware.ts`), or an admin can click "Sync from GitHub"
   in `/admin` for it immediately. Either way this only stores the binary (worker KV,
   byte-exact — no gzip) and its SHA-256 in D1's `firmware_releases` table; it does
   **not** roll anything out to devices by itself.
4. An admin explicitly sets a firmware **target** version for a specific device MAC
   in `/admin`'s Firmware panel (see `worker/src/lib/firmware-target.ts`, mirroring
   `lib/schedule.ts`'s per-device-only schedule overrides). There is deliberately no
   shared `'default'`/`'global'` target any authenticated user could set for every
   device on the server at once — that was removed as a cross-tenant risk (see
   privacy review, 2026-07-13): even with the rollback safety net below, a firmware
   that boots but is silently broken can still take several wake cycles to recover
   from, so letting any signed-up account force-flash every other tenant's devices
   was a real risk to other tenants' hardware, not just a config convenience. No
   target ever set means a device's firmware is never touched.
5. On its next wake, `GET /device_config` includes `firmware_version` /
   `firmware_sha256` when a target resolves for that device. If it differs from the
   firmware's own compiled-in `FIRMWARE_VERSION`, the device downloads
   `GET /firmware_bin?version=X`, verifies the streamed SHA-256 (via mbedtls, before
   committing), flashes it with the ESP32 `Update` library, and reboots. A failed or
   corrupt download aborts cleanly and leaves the running firmware untouched.

**Safety model:** the stock Arduino-ESP32 core for esp32s3 (as pulled by this
project's unpinned `platform = espressif32`) ships with both
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` and `CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH`
(ELF format) on by default, and the board's own `default_8MB.csv` (already in
place — no partition change or one-time USB reflash was needed) already reserves a
64KB `coredump` partition alongside the two 3264KB OTA app slots (versus the
~1.1MB firmware.bin this project currently produces). `firmware/src/ota_health.h/
.cpp` drives both:
  - **Boot-time crash → automatic rollback.** `Update.end(true)` (called from
    `performFirmwareOTA()`) leaves the freshly-flashed partition in the bootloader's
    `PENDING_VERIFY` state. If it panics/watchdog-resets before confirming itself,
    the *next* boot's bootloader detects the still-pending state and switches back
    to the previous partition on its own, before any application code runs.
  - **Boots fine but never works → app-forced rollback.** That bootloader mechanism
    only guards against boot-time crashes, not firmware that boots but never manages
    to prove itself (e.g. a WiFi/HTTP regression). `OtaHealth` tracks an NVS boot-
    attempt counter across wake cycles and calls
    `esp_ota_mark_app_invalid_rollback_and_reboot()` after
    `OTA_MAX_UNCONFIRMED_BOOT_ATTEMPTS` (3) boots without a successful authenticated
    `/device_config` round trip (`OtaHealth::confirmHealthy()`, called right after
    that succeeds, is what cancels the rollback watch for good).
  - **Crash/rollback reporting.** Whenever either path fires, or a core dump is
    present in flash from an unrelated crash, `OtaHealth` builds a compact JSON
    report (reset reason via `esp_reset_reason()`, plus `esp_core_dump_get_summary()`'s
    crashing task/PC/backtrace when available) and queues it in NVS. `main.cpp`'s
    `sendCrashReportIfPending()` uploads it to `POST /crash_report` once connectivity
    is confirmed each wake; `/admin`'s Firmware panel lists recent reports per device.
  - This is still not a substitute for staged rollout — a bad firmware that neither
    crashes nor fails its `/device_config` round trip (e.g. one that garbles the
    display but is otherwise "healthy") won't trigger any of the above. Target one
    device's MAC, confirm it's actually behaving correctly, then target the next.

### Color Palette

The Spectra 6 supports 6 colors with these hardware codes:
- 0x00: Black
- 0x01: White
- 0x02: Yellow
- 0x03: Red
- 0x05: Blue
- 0x06: Green

### Reference
- Seeed documentation: https://wiki.seeedstudio.com/getting_started_with_ee02/#getting-started-with-arduino
- Seeed GFX library (cloned locally at ~/Seeed_GFX): Contains the official T133A01 display driver. Our init register values and sequences have been verified to match exactly. The library defines this board/display combo as `BOARD_SCREEN_COMBO 510` with `USE_XIAO_EPAPER_DISPLAY_BOARD_EE02`.
- Display driver based on: https://github.com/acegallagher/esphome-bigink
- Image processing based on: ~/eink/send_to_display.py (GooDisplay project)
- Battery ADC circuit based on EE04 documentation: https://wiki.seeedstudio.com/epaper_ee04/
