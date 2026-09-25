# Seeed EE02 / EE04 E-Ink Display Project

Custom firmware + a Cloudflare Worker backend for driving Seeed Studio XIAO
ePaper Display boards (EE02: 13.3" Spectra 6; EE04: 7.3" Six-Color), instead
of Seeed's stock firmware / SenseCraft app.

## What it does

1. Connects to your WiFi network
2. Wakes from deep sleep on a schedule, fetches an image from a Cloudflare
   Worker you deploy to your own account, and only redownloads if it changed
3. Displays the image on the e-ink panel, skipping quiet hours if configured
4. Goes back to sleep to conserve battery
5. Can update its own firmware over the air, with automatic rollback if a
   build fails to boot or never proves itself healthy

Every device, image, schedule, and firmware target is managed through the
Worker's `/admin` dashboard, stored in Cloudflare D1/KV. There's no local
server or filesystem-based image folder. Images are end-to-end encrypted:
the Worker only ever stores/serves ciphertext it cannot decrypt (see
`CLAUDE.md`'s "Encrypted Image Buckets").

## Architecture

```
┌────────────────────┐              ┌─────────────────┐
│  Cloudflare Worker   │              │   ESP32 Board    │
│  (Hono + D1 + KV)     │              │ Arduino Firmware │
│                       │◄─────────────│ GET /device_config,
│  /admin  (dashboard)   │              │  /hash, /image_packed
│  /provision (BLE setup) │─────────────►│ Display image, sleep
└────────────────────┘              └─────────────────┘
```

- The **Worker** (`worker/`) is the entire backend: device registry, image
  buckets, schedules/quiet hours, firmware catalog, crash reports.
- The **firmware** (`firmware/`) runs on the ESP32-S3 and talks to the Worker
  over HTTPS, authenticated per-request with an HMAC device signature.
- Accounts are passkey-only (Face ID / Touch ID / Windows Hello / security
  key) — no email or password anywhere.

Full API reference: `worker/openapi.yaml`.

## Requirements

- Node.js/npm, [PlatformIO](https://platformio.org/), a
  [Cloudflare account](https://dash.cloudflare.com/sign-up) (needs D1, KV,
  and a paid Workers plan — image processing is too CPU-heavy for the free
  tier's `cpu_ms` limit)
- An EE02 or EE04 board + matching panel, a USB-C **data** cable, 2.4GHz WiFi
- Chrome or Edge (desktop or Android) for Bluetooth provisioning — Web
  Bluetooth isn't supported in Safari/iOS

## Setup

**1. Deploy the Worker**

```bash
cd worker && npm install && npx wrangler login
npx wrangler d1 create eink
npx wrangler kv namespace create eink-kv
```

Wire the printed `database_id`/`id` values into `wrangler.toml`'s top-level
`[[d1_databases]]`/`[[kv_namespaces]]` blocks (leave `[env.local]`'s dummy
ids alone — that's for local dev). Then:

```bash
npm run db:migrate:remote && npm run deploy
```

This prints your Worker's URL — note it for provisioning. Optionally set a
`GITHUB_TOKEN` secret (`npx wrangler secret put GITHUB_TOKEN`) for automatic
OTA release cataloging; without it you can still sync manually from
`/admin`'s Firmware panel.

**2. Create your account** — open your Worker's URL, **Open Admin
Dashboard** → **Create account**, and follow the passkey prompt. That
passkey is your account.

**3. Build and flash the firmware**

```bash
cd firmware
pio run -e ee02-13in3          # or ee04-7in3
pio run -e ee02-13in3 -t upload --upload-port /dev/ttyACM0   # adjust port
```

Nothing needs editing first — WiFi and server settings are provisioned at
runtime. If the port isn't found, try a different (data-capable) USB cable
and press the board's reset button.

**4. Provision WiFi over Bluetooth** — a fresh board has no saved WiFi and
boots straight into setup mode, advertising as `EInk-Setup`. From Chrome/
Edge, open `https://<your-worker-url>/provision`, connect, fill in your WiFi
network/password and the server host/port `443` with **Use HTTPS** checked,
then **Save & Reboot**.

**5. Register the device** — an unregistered board shows a QR code + its MAC
instead of photos. Scan it (or open `/admin?claim=<mac>` manually) and
confirm registration with your passkey.

**6. Upload images** — from `/admin`, create a bucket and assign it to your
device, then upload JPEG/PNG/WebP/GIF/BMP photos (not HEIC — convert first).
Processing (EXIF rotation, crop, dithering, encryption) happens once at
upload time; images are then picked randomly rather than in upload order —
with more than one bucket assigned, never twice in a row from the same one.

**7. Test it** — press reset. It should connect to WiFi, check its config
and image hash, download+display if changed (20-30s of flickering), then
sleep. Set per-device quiet hours/refresh interval from `/admin`'s schedule
editor.

## Watching serial output

```bash
cd firmware
pio device monitor --port /dev/ttyACM0 --baud 115200
```

The USB serial device disappears during deep sleep, so a single session
stops after the first sleep cycle. To reattach automatically on every wake:

```bash
while true; do pio device monitor --port /dev/ttyACM0 --baud 115200; sleep 1; done
```

## Changing settings without reflashing

WiFi, server address, refresh interval, and other settings are all
reprovisioned over Bluetooth, never by reflashing:

1. Hold Button 1 (GPIO2, closest to USB) through a reset, then release after
   ~1s — or just power on a board with no WiFi saved yet, which enters
   config mode automatically.
2. Open `/provision` from Chrome/Edge, connect to `EInk-Setup`, and update
   WiFi, server host/port/HTTPS, image endpoint, refresh interval, active
   hours, or timezone offset.
3. **Save & Reboot**.

## Multiple devices, images, and firmware rollout

Everything is per-device from `/admin` — there's deliberately no
"apply to every device" toggle for images, schedules, or firmware.

- Register as many device MACs as you like, each pointed at its own bucket
  (or a shared one — see `/admin/buckets/{id}/invite` for collaborator
  access without transferring ownership).
- Per-device schedule overrides (refresh interval, active hours, timezone)
  fall back to the firmware's own defaults when cleared.
- OTA firmware rollout/rollback: see `CLAUDE.md`'s "OTA Firmware Updates".

## Troubleshooting

- **Port not found:** try a different (data, not charge-only) USB cable;
  press reset; check `ls /dev/ttyACM*` (Linux) / `ls /dev/cu.usb*` (macOS).
- **WiFi won't connect:** confirm the network is 2.4GHz; re-enter config mode
  and re-provision from `/provision` (credentials live in NVS, not
  `config.h`).
- **Device can't reach the server:** confirm the Worker is deployed
  (`curl https://your-worker.workers.dev/`) and the host/port/HTTPS settings
  match what you provisioned; for a local `wrangler dev` server, **Use
  HTTPS** must be unchecked and the board must share a network with your
  dev machine.
- **Device shows a QR code instead of photos:** it's unregistered — scan the
  code or open `/admin?claim=<mac>`.
- **Updates feel slow:** a full e-ink refresh is inherently ~20-30s; image
  decode/dither only happens once, at upload time, not on every device wake.

## Battery Monitoring

The firmware reads battery voltage once per boot (before WiFi, to avoid ADC
noise) and reports it via the `X-Battery-Voltage` header on every request.
`/admin` and the `/current` status endpoint show the latest value per device.

| Voltage | Capacity | Status |
|---|---|---|
| 4.2V+ | Full (or on USB) | GOOD |
| 3.7V | ~50% | GOOD |
| 3.3V | ~10% | LOW |
| 3.0V | Empty (cutoff) | LOW |

## Repo layout

See `CLAUDE.md`'s "Repo Layout" for the full firmware/worker file breakdown.

## Credits

Firmware display driver inspired by
[esphome-bigink](https://github.com/acegallagher/esphome-bigink).
