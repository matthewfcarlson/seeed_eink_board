# E-Ink Picture Frame

Custom firmware + backend for Seeed Studio XIAO ePaper Display boards driving
e-ink displays, replacing Seeed's SenseCraft HMI web app with our own direct
API. Two boards are supported:

- **EE02**: ESP32-S3, drives a 13.3" Spectra 6 (6-color) display via dual
  UC8179 controllers.
- **EE04**: a second board, drives a 7.3" Six-Color 800×480 panel via a
  single ED2208 controller.

Reference docs:
- Seeed EE02 getting-started: https://wiki.seeedstudio.com/getting_started_with_ee02/
- Seeed EE04 battery ADC circuit: https://wiki.seeedstudio.com/epaper_ee04/
- Seeed GFX library (cloned at `~/Seeed_GFX`): official T133A01 driver our
  init sequences were checked against (`BOARD_SCREEN_COMBO 510`,
  `USE_XIAO_EPAPER_DISPLAY_BOARD_EE02`)
- Display driver ported from: https://github.com/acegallagher/esphome-bigink
  (also has the 13.3" Spectra 6 datasheet)
- 13.3" datasheet: `13_3_E6_eInk_Display_module_Datasheet.pdf` (in that repo)

There is no local Python server anymore — an early Flask prototype
(`image_server.py`) has been removed. All storage, rotation, scheduling, and
device management live in the Cloudflare Worker (`worker/`). Don't reintroduce
a Python server; new backend behavior belongs in `worker/src/`.

## Architecture

```
[Cloudflare Worker]              [ESP32 Board]
worker/ (Hono + D1 + KV)          Arduino Firmware
      │                                │
      │ GET /image_packed              │
      │◄──────────────────────────────│ (wake from deep sleep)
      │ Returns encrypted 4bpp binary  │
      │──────────────────────────────►│ Display image, deep sleep
```

Device wakes on a timer -> connects WiFi -> HMAC-authenticated request to the
Worker -> decrypts + displays image -> sleeps. The Worker rotates through each
device's assigned image bucket(s).

## Repo Layout

- `firmware/` - one PlatformIO project, three environments: `ee02-13in3`,
  `ee04-7in3` (full product firmware, sharing logic via `lib/common/`), and
  `ee04-7in3-bringup` (EE04 standalone display-driver smoke test, no
  WiFi/BLE/OTA — never shipped as a release). Each environment's
  `build_src_filter` compiles only its `src/<board>/`; `lib/common/` is
  shared by all.
  - `lib/common/device_app.h` - shared app logic (WiFi, HMAC signing,
    `/device_config` sync, image fetch/decrypt, OTA, schedule math, sleep),
    templated on each board's `Display` type
  - `lib/common/config_manager.*` - NVS-persisted config (WiFi creds, server
    endpoint, schedule)
  - `lib/common/ble_provisioning.*` - BLE GATT provisioning (NimBLE)
  - `lib/common/ota_health.*` - bootloader-rollback + crash-report safety net
  - `lib/common/eink_text_display.h` - shared bitmap-font text rendering +
    4bpp buffer access, used by both boards' display drivers (CRTP)
  - `lib/common/tinfl.*` - inflate-only DEFLATE decoder (from miniz)
  - `lib/common/version.h` - one `FIRMWARE_VERSION` shared by every board
  - `src/ee02/`, `src/ee04/` - per-board `config.h` (pins/`BOARD_ID`),
    `display.h/.cpp` (driver), `main.cpp` (wiring + `setup()`/`loop()`)
  - `simulator/` - native Mac build of the real firmware (SDL2 window),
    targets local `wrangler dev`; see `simulator/README.md`
- `worker/` - Cloudflare Worker (Hono + D1 + KV): device registry, buckets,
  rotation, schedules, firmware catalog, crash reports, admin UI,
  provisioning UI. `worker/openapi.yaml` has the full API;
  `worker/src/index.ts` registers routes.

## Display Hardware (EE02)

Dual UC8179 controllers, master/slave, sharing CLK/MOSI:

| Signal | GPIO | Notes |
|---|---|---|
| CS Master | 44 | rows 0-599 |
| CS Slave | 41 | rows 600-1199 |
| CLK | 7 | shared |
| MOSI | 9 | shared |
| DC | 10 | |
| Reset | 38 | |
| Busy | 4 | HIGH = busy |
| Power | 43 | |
| Battery ADC | 1 (A0) | via voltage divider |
| ADC Enable | 6 (A5) | HIGH to enable divider, LOW to save power |

Buttons are GPIO2/3/5 (not GPIO1, despite earlier assumptions). Frame buffer:
4 bits/pixel (2px/byte), 960,000 bytes total; transposed during transfer
(buffer columns -> output rows). Battery scaling factor 7.16 (from EE04
reference); typical LiPo range 3.0V (empty) - 4.2V (full); above 4.2V means
USB power.

**Color palette:** Black `0x00`, White `0x01`, Yellow `0x02`, Red `0x03`,
Blue `0x05`, Green `0x06`.

## Runtime Configuration (BLE)

WiFi credentials and server settings are provisioned over Bluetooth LE, not
flashed in — there's no on-device HTTP config server. Hold Button 1 (GPIO2)
at boot, or just power on an unprovisioned device (empty SSID auto-enters
config mode); device advertises as `EInk-Setup`. From Chrome/Edge (desktop or
Android — Web Bluetooth isn't in Safari/iOS), open the Worker's `/provision`
page and connect. Exchanges WiFi SSID/password, server host/port/HTTPS flag,
image path, refresh interval, active hours, and a fixed UTC offset (no DST
awareness) as JSON over a custom GATT service
(schema in `ble_provisioning.h`; browser side in `worker/src/provision-ui.ts`).
Characteristics are unencrypted — Web Bluetooth can't trigger BLE bonding —
so the WiFi password crosses the air in the clear during the brief
provisioning window. Stored in NVS; survives reboots and OTA.

## Building and Flashing

```bash
cd firmware
pio run -e ee02-13in3 -t upload   # or ee04-7in3
```
A fresh flash has no WiFi credentials and boots straight into config mode —
provision over BLE as above.

## Running the Worker

```bash
cd worker && npm install
# wire D1/KV resource ids into wrangler.toml (see repo README)
npm run db:migrate:remote && npm run deploy   # or `npm run dev` for local wrangler dev
```

**Device-facing endpoints** (all require `X-Device-MAC` +
HMAC `X-Device-Nonce`/`X-Device-Signature`, see
`worker/src/lib/device-signature.ts` — not the admin API key):

| Endpoint | Purpose |
|---|---|
| `GET /image_packed` | encrypted 4bpp image (advances rotation) |
| `GET /hash` | change-detection hash |
| `GET /device_config` | resolved schedule/firmware target, epoch time, wrapped bucket keys |
| `GET /firmware_bin` | OTA binary download |
| `POST /crash_report` | crash/rollback reporting |

Firmware also sends `X-Battery-Voltage`, `X-Device-Board` (selects firmware
target/image variant), and `X-Device-Sharing-Public-Key` (P-256, base64).

## Multi-Device / Buckets

Devices are identified by MAC and assigned to **buckets** (named image
collections; `worker/src/lib/rotation.ts`, `buckets`/`device_buckets`
tables). An unregistered MAC gets a "scan to register" QR code
(`worker/src/lib/qr-registration.ts`) — never a shared/default fallback. Claim
via `/admin?claim=<mac>`; each device tracks its own rotation state. Buckets
can be shared across accounts via invite link
(`POST /admin/buckets/{id}/invite`). MAC and admin device list both show a
device's MAC for registration.

A bucket is never board-scoped. Instead, every image gets a packed+thumbnail
variant per board (`ee02-13in3`/`ee04-7in3` - see `lib/media-constants.ts`'s
`BoardGeometry`, `migrations/0019_image_board_variants.sql`'s `image_variants`
table), generated automatically on every upload
(`worker/src/client/admin.ts`'s `confirmUpload`/`reencryptOneImage` loop over
both boards from the same crop). Any device subscribed to a bucket is served
whichever variant matches its own `X-Device-Board`
(`lib/image-store.ts`'s `getImageVariant`), so one bucket happily mixes EE02
and EE04 devices. If an image somehow lacks a variant for a requesting
device's board (data that predates this feature and was never re-uploaded),
`/image_packed` falls back to the "no images assigned" QR rather than
streaming a wrong-sized buffer.

## Encrypted Image Buckets

Every image (raw/packed/thumbnail) is AES-256-GCM encrypted **client-side**
before upload — the Worker stores/serves ciphertext only and cannot decrypt
it. The full ingest pipeline (decode, EXIF-correct, crop/resize, dither, pack,
hash) runs in the browser (`worker/src/client/decode.ts`, `thumbnail.ts`,
reusing `worker/src/lib/dither.ts`/`palette.ts`, which stayed server-side only
because the QR-registration screen also needs them).

**Threat model:** defends against passive/infrastructure access (a KV/D1
dump, backup leak, an operator reading storage directly) — not against a
malicious operator shipping modified client JS to a target's browser (that JS
does the actual encrypting/decrypting; SRI doesn't help since the same Worker
serves both the HTML and the JS). What's in place is *detection*, not
prevention: `worker/scripts/record-dist-hashes.mjs` (wired into `predeploy`)
hashes the built bundles and writes `public/static/build-info.json` so the
live site self-reports what it's serving. Real deploys run via Cloudflare
Workers Builds (git-connected — push triggers a build in Cloudflare's own
ephemeral container, checked out fresh from that commit), so the record of
truth is Cloudflare's own retained per-deployment build log — the script
prints a clearly-labeled `INTEGRITY-RECORD ...` line specifically so it lands
there, immutably tied to the commit that produced it. It also appends the
same line to `worker/dist-hashes.log` (git-tracked), but that only means
anything for a local/manual `npm run deploy` — a write to it inside Workers
Builds' ephemeral container vanishes with the container, commits nothing.
Either way: reproduce a build from its claimed commit and a hash mismatch is
a contradiction anyone can catch; a `-dirty` commit suffix means the entry
is unverifiable.

**Crypto** (`worker/src/client/crypto.ts`): each bucket has its own random
AES-256-GCM key (`nonce(12) || ciphertext || tag(16)` per blob), generated
client-side and never uploaded raw. Every principal (user or device) has a
P-256 keypair; wrapping a bucket key for a principal is hand-rolled ECIES
(ephemeral P-256 -> ECDH -> HKDF-SHA256 -> AES-256-GCM), domain-separated by
HKDF `info` string per purpose. `bucket_keys` (D1) holds one wrapped copy per
`(bucket_id, principal_type, principal_id, key_version)`.

A user's sharing keypair is protected by their passkey's WebAuthn PRF
extension (`users.sharing_public_key`, `credentials.wrapped_sharing_key` —
per-credential, since PRF output is scoped to the credential). No usable PRF
result falls back to keeping the keypair in that browser's IndexedDB only
(`worker/src/client/keystore.ts`) — bucket access then works only from that
browser. This IndexedDB cache is written on every successful PRF recovery,
not just the no-PRF path, trading broader convenience for a bigger exposure
window if that browser's storage is read. A synced passkey (iCloud Keychain,
Google Password Manager) recovers the same key on a second browser, when PRF
comes through — it often doesn't over hybrid/QR cross-device auth. If a
ceremony can't recover an *already-established* server identity, the client
now throws rather than silently minting a new, unrecognized keypair; it only
auto-generates when the server has no identity yet.

Sharing a bucket: the invite link carries the raw key in a `#key=` URL
fragment (never sent to the server/logs); the invitee's browser reads it,
re-wraps a durable copy for their own key, then drops the fragment.

**Firmware side** (`device_app.h`): generates a P-256 keypair on first boot,
persists it via `ConfigManager`, reports the public half via
`X-Device-Sharing-Public-Key`. `syncRemoteConfigAndTime()` unwraps bucket
keys fresh each wake (ECDH+HKDF) into `RunState`. `/image_packed` streams
straight into the display buffer and decrypts/inflates in place — `display.
refresh()` is only called after the GCM tag verifies, so a tampered or
incomplete download is never shown.

Two mbedtls gotchas found by building this, not from docs:
- Stock ESP32 Arduino mbedtls declares `mbedtls_hkdf()` but doesn't link it —
  `device_app.h` hand-rolls RFC 5869 from `mbedtls_md`'s HMAC instead.
- Simulator's mbedtls stubs (`simulator/stubs/mbedtls/{ecp,ecdh,gcm}.h`) must
  be `#include`d before `<ArduinoJson.h>` — `MacTypes.h`'s global `Ptr`
  typedef collides with ArduinoJson's `using namespace ArduinoJson;`.

**Bucket-key rotation** (`0016_bucket_key_rotation.sql`): owner-triggered from
`/admin` — new key, every blob re-encrypted, re-wrapped for currently
authorized principals, old-version `bucket_keys` rows deleted (the actual
revocation). Client-driven (Worker can't decrypt): `POST /admin/buckets/:id/
rotate/start` -> per-image `.../reencrypt-image/:imageId` (resumable via
`.../rotate/status`) -> `.../finalize`. Expensive — a full re-download/
re-upload of every image — and the UI says so.

**Packed-blob compression** (`0017_packed_encoding.sql`): client deflates the
packed buffer before encrypting when it clears a savings threshold
(`worker/src/client/compress.ts`; `images.packed_encoding`, echoed via
`X-Packed-Encoding`). Firmware inflates via `tinfl` (miniz's inflate-only
extract) in small streaming chunks straight into the display buffer,
alongside GCM decryption. EE04 static RAM is ~78% used after this feature —
tight, worth watching before adding more.

**Known gaps:**
- No way to add a second passkey — losing your one passkey permanently loses
  access to every bucket you own or were shared (operator can't recover it).
- No ESP32 flash encryption — a stolen device's on-device private key (and
  every bucket key wrapped for it) isn't protected at rest.
- Rotating a bucket's key re-derives images from the stored raw original with
  a centered/no-zoom crop — per-image crop/pan/zoom isn't persisted, so a
  custom crop resets on rotation. Cosmetic, not a security issue.
- The upload crop UI shows one reference board's aspect ratio (EE02's
  portrait 3:4); the other board's variant is derived from the same
  `panX`/`panY`/`zoom` fractions applied to its own aspect ratio, not a
  second interactive preview — reasonable for centered content, imprecise
  for an off-center manual crop on boards with very different shapes.
- No devices have shipped yet, so encrypted buckets were a breaking change
  with no plaintext migration path. Once real devices exist, firmware must be
  OTA'd and confirmed running before any future breaking Worker change ships.

## Image Rotation

Accepted upload formats: JPEG, PNG, WebP, GIF, BMP (HEIC/HEIF depends on the
browser's `createImageBitmap` support). All processing (EXIF correction,
crop/resize, dithering, palette-packing, encryption) happens client-side at
upload time; the Worker's `/admin/images/upload` just validates and stores
ciphertext. Selection is "human random" rather than sequential
(`worker/src/lib/rotation.ts`): never twice in a row from the same bucket
while another subscribed bucket has an image to offer, and never an image
still inside a recency window of about half the collection. The bucket is
picked weighted by image count, so among eligible buckets every image has
roughly an equal chance — but no bucket weighs more than 4x the smallest
eligible one (`MAX_BUCKET_WEIGHT_RATIO`), so a 2000-photo bucket can't bury a
30-photo one (80/20, not 98.5/1.5). With
exactly two buckets the rule still forces strict alternation however
lopsided they are; weighting only matters from three buckets up. The pick is a
seeded PRNG over persisted state (`rotation_state`'s `last_returned`,
`last_bucket_id`, `recent_image_ids` — see
`migrations/0022_random_rotation.sql`), not `crypto.getRandomValues`, so
`/hash`, `/current` and the `/image_packed` that follows them all agree on
which image is next while only `/image_packed` writes state. Rotation state
is tracked per-device, and two devices sharing the same buckets are seeded
with their own MAC so they don't march in lockstep. Uploading/deleting takes
effect on the device's next `/image_packed` request, which also records what
was served.

**Duplicate detection** (`migrations/0020_image_content_hash.sql`): uploads
may carry a `content_hash` — a bucket-key-keyed HMAC-SHA256 over the default
board's *plaintext* packed buffer, computed client-side before
compression/encryption (`worker/src/client/crypto.ts`'s
`computeContentHash`; the existing `packed_hash` hashes ciphertext, whose
random GCM nonce makes it useless for this). The Worker rejects a duplicate
rendition with 409 naming the existing filename; the UI offers "upload
anyway" (retries with `?allow_duplicate=1`). Keying with the bucket key
means the Worker can only compare hashes within one bucket — no cross-bucket
correlation of identical photos. Bucket-key rotation recomputes every image's
hash under the new key via the reencrypt path. Trusted client metadata (the
Worker can't verify it) — a courtesy check, not a security boundary.

## OTA Firmware Updates

Channel-based (`stable`/`beta`), not admin-picked versions
(`firmware_targets.channel`, `worker/src/lib/firmware-target.ts`). `beta`
currently resolves to nothing. `stable` always resolves to the newest
cataloged release for that device's board (devices self-report board via
`X-Device-Board`; `firmware_releases` is keyed by `(board, version)`). No
channel set = never touched. There's deliberately no shared "default" target
any account could set for every device — removed as a cross-tenant risk
(2026-07-13 privacy review).

**Flow:** bump `FIRMWARE_VERSION` in `lib/common/version.h` (one version for
every board) -> commit -> `git tag vX.Y.Z` -> push. CI
(`.github/workflows/release-firmware.yml`) builds every product-firmware
environment and attaches board-specific assets (`firmware-ee02-13in3.bin`,
`firmware-ee04-7in3.bin`, never `ee04-7in3-bringup`) to the GitHub release.
The Worker catalogs new releases via a 6h cron or an admin's "Sync from
GitHub" click (`worker/src/routes/admin/firmware.ts`) — every `stable`
device on that board gets it on its next wake. Admin sets a device's channel
via `PUT /admin/firmware/target/:target`. On wake, `/device_config` includes
`firmware_version`/`firmware_sha256` if different from the running version;
firmware downloads `/firmware_bin?version=X`, verifies SHA-256, flashes via
`Update`, reboots. A failed/corrupt download aborts and leaves the running
firmware untouched.

**Tradeoff:** no way to pin a device to a known-good version or stage a
rollout — every `stable` device on a board moves together as soon as a
release is cataloged.

**Safety net** (`lib/common/ota_health.*`, uses the ESP32 Arduino core's
default bootloader-rollback + coredump-to-flash support):
- Crash before boot confirms itself -> bootloader auto-reverts to the
  previous partition on next boot (no app code needed).
- Boots but never completes an authenticated `/device_config` round trip
  within `OTA_MAX_UNCONFIRMED_BOOT_ATTEMPTS` (3) wakes -> app forces a
  rollback itself.
- Either path (or an unrelated core dump in flash) queues a JSON crash report
  (reset reason, crashing task/PC/backtrace) uploaded to `POST /crash_report`
  once connectivity returns; `/admin`'s Firmware panel lists recent reports.
- This does **not** catch firmware that boots and syncs fine but is otherwise
  broken (e.g. garbled display) — watch a release's first few devices in
  `/admin` after syncing rather than relying on staged rollout.
