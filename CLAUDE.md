Seeed studios makes a development board called the XIAO ePaper Display Board - EE02 that is designed to drive an e ink spectra 6 13.3 inch display.  The board is based on the ESP32-s3 chip and supports WiFi and Bluetooth connectivity.

The board is relatively new and there is limited documentation and community support available for it. However, Seeed Studio recently published this documentation: https://wiki.seeedstudio.com/getting_started_with_ee02/#getting-started-with-arduino

There is also a github repository that is trying to do the same thing we are in terms of directly addressing the EE02 XIAO ePaper Display Board at https://github.com/acegallagher/esphome-bigink.

Note that in this repository there is also documentation of the 13.3 inch spectra 6 driver: 13_3_E6_eInk_Display_module_Datasheet.pdf

Seeed provides a web app called the SenseCraft HMI platform to communicate with the e ink display. However. we don't want to go through the WebApp to display images, we want to directly hit the api endpoints that the custom firmware that we build in this repository supports.  If you look at the ~/eink repository on this computer, you will see that I have done something similar with the GooDisplay e ink driver board. We used the GooDisplay web app to reverse engineer the api endpoints and then wrote a python script to hit those endpoints directly but the GooDisplay web app was pretty simple.

This repository now contains custom firmware for the ESP32 on the EEO2 board that runs a web client that generates http requests to our backend (a Cloudflare Worker — see `worker/`) to display images on the 13.3 inch spectra 6 display.  We also have the capability to put the ESP32 to sleep and have it wake up at intervals to update the display.  The ESP32 wakes up, connects to WiFi, makes a request to the Worker to get the image to display, displays the image, and then goes back to sleep.  The Worker rotates through the images in each device's bucket (a named image collection, assigned per device MAC via `/admin`). We can manage the images that each screen displays by uploading or deleting them from that screen's bucket in the admin dashboard.

There used to be a local Python (`image_server.py`, Flask) implementation of this same server, used for early development. It has been removed entirely — all image storage, rotation, scheduling, and device management now live in the Cloudflare Worker (`worker/`), backed by D1 and KV. Do not reintroduce a Python server; any new backend behavior belongs in `worker/src/`.

## Custom Firmware Implementation

We have implemented custom Arduino/PlatformIO firmware in the `firmware/` directory:

### Architecture

```
[Cloudflare Worker]              [EE02 Board]
worker/ (Hono + D1 + KV)          Arduino Firmware
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

`firmware/` is one PlatformIO project with three environments — `ee02-13in3`
and `ee04-7in3` (this board and a second board, both full product firmware,
sharing almost all their logic via `lib/common/` — see "EE04 Firmware" below)
and `ee04-7in3-bringup` (EE04's standalone display-driver bring-up sketch,
predates and is unrelated to normal operation). Each environment compiles
only its own `src/<board>/` subdirectory via `build_src_filter` (`src_dir`
itself isn't overridable per-environment in PlatformIO); `lib/common/` (unlike
`src_dir`) *is* project-global and automatically shared by every environment.

- `firmware/platformio.ini` - PlatformIO project configuration (all three environments)
- `firmware/lib/common/config_manager.h/.cpp` - Persistent configuration storage (NVS), including WiFi credentials
- `firmware/lib/common/ble_provisioning.h/.cpp` - Bluetooth LE GATT configuration interface (NimBLE)
- `firmware/lib/common/ota_health.h/.cpp` - bootloader-rollback + crash-report safety net (see "OTA Firmware Updates" below)
- `firmware/lib/common/version.h` - one shared `FIRMWARE_VERSION` for every board
- `firmware/lib/common/device_app.h` - the shared app logic (WiFi, HMAC signing, `/device_config` sync,
  image fetch/decrypt, bucket-key unwrap, OTA download/flash, schedule math, deep sleep), templated on each board's `Display` type
- `firmware/simulator/stubs/mbedtls/{ecp,ecdh,gcm}.h` - macOS stand-ins for the
  P-256 ECDH (via Security.framework) and AES-GCM (hand-rolled — see
  "Encrypted Image Buckets") mbedtls calls `device_app.h` needs, alongside the
  existing `sha256.h`/`md.h` (CommonCrypto-backed)
- `firmware/src/ee02/config.h` - Pin definitions, `BOARD_ID`, non-secret defaults (no WiFi credentials — see below)
- `firmware/src/ee02/display.h/.cpp` - Spectra 6 display driver (ported from esphome-bigink)
- `firmware/src/ee02/main.cpp` - Board-specific wiring (instantiate `Display`/`ConfigManager`/etc., config-mode screen) + `setup()`/`loop()`
- `firmware/src/ee04/` - EE04's equivalent of the above, plus its `#ifdef EE04_BRINGUP_TEST_MODE`-gated standalone bring-up path — see "EE04 Firmware" below
- `worker/` - Cloudflare Worker backend (Hono + D1 + KV): device registry, image
  buckets/rotation, schedules, firmware catalog/targets, crash reports. See
  `worker/openapi.yaml` for the full API and `worker/src/index.ts` for route
  registration.

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
(`firmware/lib/common/ble_provisioning.h` documents the exact characteristic schema);
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
2. Optionally edit `firmware/lib/common/config_manager.h` to change default server settings
3. Connect EE02 board via USB
4. Build and upload:
   ```bash
   cd firmware
   pio run -e ee02-13in3 -t upload
   ```
5. Provision WiFi over Bluetooth (see "Runtime Configuration" above) — a fresh
   flash has no WiFi credentials, so the device boots straight into config mode.

### EE04 Firmware

A second board, `firmware/src/ee04/` (env `ee04-7in3`), targets the EE04
board + a 7.3" Six-Color 800×480 panel (single ED2208 controller, vs. this
board's dual UC8179s). It has the same feature set as EE02 — WiFi, Worker
sync, BLE provisioning, OTA, deep sleep, battery monitoring — sharing that
logic via `firmware/lib/common/`'s templated `device_app.h` (see "Files"
above); its own `main.cpp`/`display.h/.cpp`/`config.h` hold only the ED2208
driver, pin map, and buffer geometry that are genuinely different from EE02.
Build with `pio run -e ee04-7in3 -t upload`.

A separate `ee04-7in3-bringup` environment (same `src/ee04/main.cpp`, gated
behind `#ifdef EE04_BRINGUP_TEST_MODE`) is a standalone display-driver
smoke test — no WiFi/BLE/OTA, just draws a color-bar test pattern and
refreshes once. This is what originally verified the ED2208 driver
(pin mapping, busy-pin polarity, register sequence, color codes) before the
full app existed, and stays available for the same purpose later. See
`firmware/README.md`'s "EE04 Display Bring-Up" section for the pin table
and an ordered verification checklist.

Multi-device-model support on the Worker's *image* pipeline (so EE02 and
EE04 devices can eventually share buckets with per-model resolution/palette
image variants) is still a separate, not-yet-started effort — what's
described here and in "OTA Firmware Updates" below is only about firmware
delivery, not image content.

### Device Simulator

`firmware/simulator/` (`make BOARD=ee02|ee04`, run from that directory) is a
native Mac build of the real firmware — `firmware/lib/common/*.cpp` and the
chosen board's `display.cpp`/`main.cpp` compiled directly and unmodified
against Arduino/ESP32/NimBLE stub headers, rendered to an SDL2 window. It
targets a **local** `wrangler dev` by default (`--server` to point elsewhere;
never point it at production). Real BLE provisioning
(`ble_provisioning.cpp`) is exercised through the actual `/provision` page —
its `?sim=<origin>` query param switches that page's transport from Web
Bluetooth to a small HTTP+SSE bridge the simulator runs
(`firmware/simulator/gatt_bridge.cpp`), since there's no way to run a real
BLE peripheral from a Mac process. See `firmware/simulator/README.md` for
setup and known limitations — notably, simulating `ee04-7in3` surfaces the
same image-geometry gap described above (an oversized buffer rejected by the
firmware's own size check) through the real firmware code, not a simulated
approximation of it.

### Running the Worker Backend

1. `cd worker && npm install`
2. Create D1/KV resources and wire their ids into `wrangler.toml` (see repository
   root `README.md`'s "Deploy the Cloudflare Worker" step)
3. `npm run db:migrate:remote` then `npm run deploy` — or `npm run dev` for a
   local `wrangler dev --env local` instance against `[env.local]`'s dummy ids

**Device-facing endpoints:**
- `/image_packed` - Returns 960KB of pre-processed 4bpp binary data (advances rotation)
- `/hash` - Returns 16-char hash for change detection
- `/device_config` - Resolved schedule/firmware target, plus epoch time for clock sync
- `/firmware_bin` - OTA firmware binary download
- `/crash_report` - Crash/rollback reporting (POST)

All device-facing endpoints require an `X-Device-MAC` header plus an HMAC
`X-Device-Nonce`/`X-Device-Signature` pair (see `worker/src/lib/device-signature.ts`) —
not the admin Bearer API key. The firmware also sends `X-Battery-Voltage` (e.g.,
"3.85"), `X-Device-Board` (e.g. "ee02-13in3"), and `X-Device-Sharing-Public-Key`
(base64 P-256 public key, see "Encrypted Image Buckets") headers, self-reporting
battery level, which board this is, and its encryption identity — the board is
how `/device_config` resolves the right per-board firmware release (see "OTA
Firmware Updates"). Full schema: `worker/openapi.yaml`.

### Multi-Device Support

The Worker supports multiple EE02 boards under one account, each identified by
MAC address and assigned to one or more **buckets** (named image collections;
see `worker/src/lib/rotation.ts` and the `buckets`/`bucket_subscriptions` D1
tables). A bucket can be shared between accounts via an invite link
(`POST /admin/buckets/{id}/invite`), so multiple people can collaborate on one
device's images without transferring ownership.

**How it works:**
1. Each ESP32 sends its MAC address (lowercase, no separators) via `X-Device-MAC`
2. An unregistered MAC gets a "scan to register" QR code instead of any bucket's
   content (see `worker/src/lib/qr-registration.ts`) — never a shared/default
   fallback (see `migrations/0009_bucket_ownership.sql`)
3. Once claimed via `/admin?claim=<mac>`, the device rotates through the images
   in its assigned bucket(s)
4. Each device maintains its own rotation cursor in D1

**Finding your device's MAC:** shown on the device's own display (as part of the
registration QR screen) and in `/admin`'s device list once registered.

### Encrypted Image Buckets

Every image (raw original, packed 4bpp buffer, dashboard thumbnail) is
AES-256-GCM encrypted client-side before it ever reaches the Worker — the
Worker stores and serves ciphertext only and cannot decrypt it, even with
full read access to its own D1/KV. This isn't just "encryption at rest": the
whole ingest pipeline (decode → EXIF-correct → crop/resize → dither → pack →
hash) moved from the Worker into the browser (`worker/src/client/decode.ts`,
`thumbnail.ts`, reusing `worker/src/lib/dither.ts`/`palette.ts` as-is — those
two stayed in `lib/` rather than moving wholesale because
`lib/qr-registration.ts`'s synthetic "scan to register" screen still needs
them server-side). `worker/src/lib/decode.ts` itself now holds only
`rotate90CW`, for the same reason.

**Threat model, stated precisely:** this defends against passive/
infrastructure access — a KV/D1 dump, a backup leak, anyone with read access
to the Worker's storage, including the operator. It does **not** defend
against a malicious operator (or a compromised deploy pipeline) shipping
modified client JS to a targeted victim's browser, since that JS is what
does the actual encrypting/decrypting. No code-integrity mechanism (SRI,
reproducible builds) exists to close that gap.

**Crypto primitives** (`worker/src/client/crypto.ts`):
- Each bucket has its own random AES-256-GCM content key, generated
  client-side at bucket creation and never uploaded raw. Every stored blob
  is `nonce(12) || ciphertext || tag(16)`.
- Every principal — user or device — has a P-256 keypair. Wrapping a bucket
  key for a principal is hand-rolled ECIES (WebCrypto/mbedtls have no
  built-in "encrypt to a public key" call): ephemeral P-256 keypair → ECDH →
  HKDF-SHA256 → AES-256-GCM. HKDF `info` strings are domain-separated
  per purpose (`eink-bucket-wrap-v1` vs `eink-sharing-key-wrap-v1`) so the
  same derived secret can never be reinterpreted for the other purpose.
- `bucket_keys` (D1) holds one ECIES-wrapped copy of a bucket's key per
  `(bucket_id, principal_type, principal_id)` — deliberately separate from
  `bucket_shares`/`device_buckets`, which stay pure authorization tables.

**A user's own sharing keypair** is protected by their passkey's WebAuthn PRF
extension, not a separate password: `users.sharing_public_key` and
`credentials.wrapped_sharing_key`/`wrap_nonce` (per-credential, since PRF
output is scoped to the credential, not the account — see
`worker/src/lib/webauthn.ts`'s `PRF_EXTENSION_INPUT`). If an authenticator
never returns a usable PRF result, the client falls back to keeping the
keypair in this one browser's IndexedDB only (`worker/src/client/keystore.ts`)
— bucket access from that account then works only from that browser.
Backfilling a wrap (first successful PRF result for a credential that didn't
have one yet) goes through `PATCH /admin/me/sharing-key`, a *separate*,
normally-authenticated call — not a field on `/auth/login/verify` itself,
because that ceremony's challenge is single-use and already consumed by the
time the client can decide a backfill is needed.

**Sharing a bucket:** the invite link (`POST /admin/buckets/{id}/invite`,
unchanged) gains a `#key=<base64url>` URL fragment carrying the raw bucket
key, appended client-side — a fragment is never sent to the server in any
request, Referer header, or server log. The invitee's browser reads it off
`location.hash`, immediately re-wraps a durable copy for their own key via
`POST /admin/buckets/join`, and drops the fragment from the URL. Assigning a
bucket to a device needs no link: the owner's browser already holds the raw
key and just wraps a copy for the device's `sharing_public_key`
(`PATCH /admin/devices/{mac}/buckets`).

**Firmware side** (`firmware/lib/common/device_app.h`): each device
generates its own P-256 keypair on first boot
(`ensureSharingKeyPair()`, persisted via `ConfigManager` — note the private
key's stored byte length is *not* a fixed 32 bytes across build targets, see
below) and self-reports the public half via
`X-Device-Sharing-Public-Key` on every request, the same pattern
`X-Device-Board` already used (`worker/src/lib/auth-device.ts`'s
`recordDeviceSeen`). `GET /device_config` includes this device's wrapped
bucket key(s) (`bucket_keys` in the response); `syncRemoteConfigAndTime()`
unwraps each fresh every wake via ECDH + HKDF (`unwrapBucketKey()`) and
caches them in `RunState` for that wake only. `/image_packed`'s response is
AES-256-GCM ciphertext, selected by its `X-Bucket-Id` header against the
device's unwrapped keys; `fetchAndDisplayImage()` still streams straight into
the display's own buffer (no second allocation — `Content-Length` is now
`display.getBufferSize() + 28`) and decrypts it in place, but never calls
`display.refresh()` until `mbedtls_gcm_auth_decrypt()`'s tag check passes —
a corrupt or tampered download is left undisplayed, same as an incomplete one.

**Two real mbedtls surprises found only by actually building this**, not
assumed from documentation:
- The stock ESP32 Arduino core's mbedtls declares `mbedtls_hkdf()` in its
  headers but doesn't link it (`undefined reference` at real `pio run` link
  time) — `device_app.h`'s `hkdfSha256()` hand-rolls RFC 5869 from
  `mbedtls_md`'s HMAC primitive instead (already linked in for
  `computeDeviceSignature()`), which does work on both targets.
- `firmware/simulator/`'s stubs for this (`stubs/mbedtls/ecp.h`, `ecdh.h`,
  bridging P-256 ECDH through macOS Security.framework, since CommonCrypto
  has no EC API) must be `#include`d *before* `<ArduinoJson.h>` in
  `device_app.h` — Security.framework's `MacTypes.h` declares a global `Ptr`
  typedef that becomes ambiguous against vendored ArduinoJson's own
  `ArduinoJson::Ptr` once `ArduinoJson.h`'s trailing `using namespace
  ArduinoJson;` is in effect. `stubs/mbedtls/gcm.h` hand-rolls AES-GCM
  entirely (CommonCrypto has no public GCM API on this SDK either) —
  verified byte-for-byte against real WebCrypto output before being
  committed, since a self-consistent-but-wrong implementation would round-trip
  fine locally while failing to interoperate with anything real.

**Bucket-key rotation** (migrations `0016_bucket_key_rotation.sql`) closes the
revocation gap above: an owner can rotate a bucket's key from `/admin` (a new
AES-256-GCM key, every image's raw/packed/thumb blobs re-encrypted under it,
then re-wrapped for every *currently* authorized principal). `buckets.
key_version` and `images.key_version` track which generation each image is
actually encrypted under; `bucket_keys`' primary key is `(bucket_id,
principal_type, principal_id, key_version)` so an old and new wrapped key can
coexist for a principal for the duration of the job. Because the Worker can't
decrypt, the client drives the whole thing — `POST /admin/buckets/:id/rotate/
start` → per-image `POST .../reencrypt-image/:imageId` (idempotent, resumable
via `GET .../rotate/status` if the tab closes mid-job) → `POST .../finalize`,
which recomputes the authorized-principal set fresh (so a share added
mid-rotation is still included), upserts new-version `bucket_keys`, **deletes
the old-version rows** (the actual revocation), and bumps `buckets.
key_version`. This is a genuinely expensive operation — structurally a full
re-download-and-re-upload of every image in the bucket, since there's no way
to shortcut it without the Worker ever holding a key — and the confirmation
UI says so. `/device_config`'s `bucket_keys` entries and `/image_packed`'s
response both carry `key_version` (`X-Bucket-Key-Version` header); firmware's
`BucketKey` struct and `fetchAndDisplayImage()`'s lookup match on `(bucket_id,
key_version)` together, not `bucket_id` alone, precisely so a device holding
both an old and new key mid-rotation picks the right one per image.

**Packed-blob compression** (migration `0017_packed_encoding.sql`) also
shipped: the client compresses the packed 4bpp buffer with `CompressionStream
('deflate-raw')` before encrypting, only when it clears a minimum savings
threshold (`worker/src/client/compress.ts`), and records `images.
packed_encoding` (`identity` or `deflate-raw`, echoed via `/image_packed`'s
`X-Packed-Encoding` header — `Content-Length` for a compressed image is a
sanity-bounded upper limit, not the fixed `bufferSize + 28` an identity
response still gets). Real dithered content compresses well (measured
32–76% smaller depending on how flat vs. noisy the image is — even a
deliberately adversarial fully-random-index buffer cleared 32%). Firmware
inflates via `tinfl` (`firmware/lib/common/tinfl.h/.c`, the inflate-only
extract of miniz, taken from a copy of `miniz.c` already vendored on this
project's own machine by esptool's flasher stub — not written from scratch,
since a subtly-wrong DEFLATE decoder is exactly the kind of bug that's easy
to ship and hard to notice). `fetchAndDisplayImage()` decrypts+inflates in
small fixed-size streaming chunks straight into `display.getBuffer()` (via
mbedtls's incremental `mbedtls_gcm_starts/_update/_finish` and `tinfl`'s
`TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF` mode, which lets that same buffer
double as inflate's own history window) — not decrypt-into-a-second-buffer-
then-inflate, which doesn't fit EE04's memory budget. `display.refresh()` is
still only reached after the GCM tag verifies, same invariant as the
identity path. **EE04 is now at ~78% static RAM usage** (was ~75% before this
feature) — tight, flagged deliberately, not a false green light. The
simulator's GCM stub (`firmware/simulator/stubs/mbedtls/gcm.h`) grew the same
streaming trio, hand-rolled the same way as its existing one-shot function,
and was cross-checked against real WebCrypto output the same way.

**Known gaps, not oversights:**
- No way to register a second passkey on an existing account. Losing your
  one passkey now means permanently losing access to every bucket you own or
  were shared — not just losing login, since the operator can't recover a
  plaintext account for you anymore either.
- No ESP32 flash encryption. A lost/stolen device's on-device private key
  (and therefore every bucket key ever wrapped for it) isn't protected at
  rest.
- Rotating a bucket's key re-derives every image from its stored raw
  original using a centered/no-zoom crop, because per-image crop/pan/zoom
  choices aren't persisted anywhere — they're baked into pixels at upload
  time. An image originally uploaded with a custom crop reframes to
  centered/no-zoom after a rotation. Cosmetic, not a security issue.
- No devices have shipped yet, so encrypted buckets landed as a breaking
  change with no migration path for older plaintext-format images —
  re-upload is the only option. If real devices exist by the time this
  changes again, firmware must be OTA'd and confirmed running *before* the
  Worker side deploys, since a bare Worker deploy would instantly break any
  device still on old firmware.

### Image Rotation

- **Accepted upload formats:** JPEG, PNG, WebP, GIF, BMP — HEIC/HEIF support
  depends on the browser's own `createImageBitmap` (Safari can decode it
  natively; Chrome/Firefox generally can't — see `client/decode.ts`)
- **Processing:** done once, client-side, at upload time — EXIF correction,
  crop/resize, dithering (Floyd-Steinberg/Atkinson/ordered) to the 6-color
  palette, packing to 4bpp, and AES-256-GCM encryption (see "Encrypted Image
  Buckets" above; `worker/src/client/decode.ts`, `dither.ts`, `crypto.ts`) —
  the Worker's `/admin/images/upload` just validates and stores the resulting
  ciphertext blobs
- **Rotation order:** upload order, tracked per-device in D1 (`worker/src/lib/rotation.ts`)
- **Dynamic updates:** uploading/deleting an image in `/admin` takes effect on
  the device's next `/image_packed` request

Each request to `/image_packed` advances to the next image in rotation for that specific device.

### Battery Monitoring

The EE02 board has a voltage divider circuit (same as the EE04 board) that allows reading battery voltage via ADC:

- **GPIO1 (A0):** Battery voltage ADC input (through voltage divider)
- **GPIO6 (A5):** ADC enable pin - must be set HIGH before reading
- **Scaling factor:** 7.16 (voltage divider ratio, from EE04 reference)
- **Note:** GPIO1 is NOT a button despite earlier assumptions. The three physical keys on the board are on GPIO2, GPIO3, and GPIO5 (matching EE04 layout).

The firmware reads battery voltage once per boot (before WiFi to avoid ADC noise) and sends it to the Worker via the `X-Battery-Voltage` HTTP header. The Worker stores the latest value per device (D1) and `/admin`'s device list renders it as a percentage (`worker/src/client/admin.ts`'s `batteryPercent()`, calibrated to that same 3.0V–4.2V range).

Typical LiPo voltage range: 3.0V (empty) to 4.2V (full). Readings above 4.2V indicate USB power.

### OTA Firmware Updates

Firmware updates are delivered over the same channel as images/config — the ESP32
already wakes, connects to WiFi, and talks to the Worker every cycle, so OTA piggybacks
on that instead of adding a separate update mechanism.

**Channel-based, not admin-picked versions (migrations/0014):** there is no
UI or API to target a specific version string anymore. Each device is set to
either the `stable` or `beta` channel (`firmware_targets.channel`); `beta`
currently resolves to nothing (no beta pipeline exists yet — same as no
channel set), and `stable` always resolves to whatever is the *newest*
cataloged release for that device's own board — see
`worker/src/lib/firmware-target.ts`'s `resolveFirmwareTarget()`. Board-aware
throughout: every device self-reports its board via `X-Device-Board` (see
"Device-facing endpoints" above), and `firmware_releases` is keyed by
`(board, version)`, not just `version`, since the same version tag produces
a different binary/SHA-256 per board.

**Flow:**
1. Bump `FIRMWARE_VERSION` in `firmware/lib/common/version.h` — **one shared
   version number for every board**, not one per board, so a single tag
   releases all boards' binaries together. Commit, then `git tag vX.Y.Z`
   (matching, with a leading `v`) and push the tag.
2. `.github/workflows/release-firmware.yml` builds **every** product-firmware
   environment (`ee02-13in3`, `ee04-7in3`) with PlatformIO and attaches each
   as its own board-specific asset (`firmware-ee02-13in3.bin`,
   `firmware-ee04-7in3.bin`) to the same GitHub release — never the generic
   `firmware.bin`, and never `ee04-7in3-bringup` (a standalone manual-use
   environment, not a release target — see "EE04 Firmware" above).
3. The Cloudflare Worker catalogs new releases automatically (a `scheduled()` Cron
   Trigger polls the GitHub releases API every 6h — see `wrangler.toml`'s `[triggers]`
   and `worker/src/routes/admin/firmware.ts`), or an admin can click "Sync from GitHub"
   in `/admin` for it immediately — this loops over every known board id, syncing
   whichever assets are present in that release, one row per board in D1's
   `firmware_releases` table (worker KV holds the binary itself, byte-exact —
   no gzip). **Every `stable`-channel device on that board starts receiving
   it on its very next wake** — unlike the old exact-version model, there is
   no separate "now roll it out" step once a release is cataloged.
4. An admin sets a device's **channel** (`stable` or `beta`) for a specific
   device MAC in `/admin`'s Firmware panel (`PUT /admin/firmware/target/:target`
   in `routes/admin/firmware.ts`, via `worker/src/lib/firmware-target.ts` —
   mirrors `lib/schedule.ts`'s per-device-only schedule overrides). There is
   deliberately no shared `'default'`/`'global'` target any authenticated
   user could set for every device on the server at once — that was removed
   as a cross-tenant risk (see privacy review, 2026-07-13): even with the
   rollback safety net below, a firmware that boots but is silently broken
   can still take several wake cycles to recover from, so letting any
   signed-up account force-flash every other tenant's devices was a real
   risk to other tenants' hardware, not just a config convenience. No
   channel ever set means a device's firmware is never touched.
5. On its next wake, `GET /device_config` includes `firmware_version` /
   `firmware_sha256` when the device's channel resolves to a release —
   resolved using *that same request's* `X-Device-Board` header directly
   (not a stale DB read-back), so this works correctly even on a device's
   very first request. If it differs from the firmware's own compiled-in
   `FIRMWARE_VERSION`, the device downloads `GET /firmware_bin?version=X`,
   verifies the streamed SHA-256 (via mbedtls, before committing), flashes
   it with the ESP32 `Update` library, and reboots. A failed or corrupt
   download aborts cleanly and leaves the running firmware untouched.

**Tradeoff worth knowing:** removing exact-version picking also removes the
ability to *pin* a device to a known-good version or stage a rollout across
devices one at a time — every `stable`-channel device on a board moves to
the newest release together, as soon as it's cataloged. The rollback safety
net below still protects against a release that crashes or fails to connect;
it does not protect against one that's "healthy" but wrong (see the note at
the end of this section). If that tradeoff ever stops being acceptable, the
fix is re-introducing an optional per-device version pin *on top of* the
channel model (e.g. a nullable `firmware_targets.pinned_version` that
overrides channel resolution when set) rather than reverting the channel
model itself.

**Safety model:** the stock Arduino-ESP32 core for esp32s3 (as pulled by this
project's unpinned `platform = espressif32`) ships with both
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` and `CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH`
(ELF format) on by default, and the board's own `default_8MB.csv` (already in
place — no partition change or one-time USB reflash was needed) already reserves a
64KB `coredump` partition alongside the two 3264KB OTA app slots (versus the
~1.1MB firmware-ee02-13in3.bin this project currently produces).
`firmware/lib/common/ota_health.h/.cpp` (shared by every board) drives both:
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
  - This is not a substitute for staged rollout, and the channel model above
    (deliberately) no longer offers one — a bad firmware that neither crashes
    nor fails its `/device_config` round trip (e.g. one that garbles the
    display but is otherwise "healthy") won't trigger any of the above, and
    every `stable`-channel device on a board updates together. Mitigate by
    watching a release's first few devices closely after it's synced (crash
    reports, `/admin`'s device list) rather than by staging targets.

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
