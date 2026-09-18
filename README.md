# Seeed EE02 E-Ink Display Project

Display images on a 13.3" Spectra 6 color e-ink display using custom firmware for the Seeed Studio XIAO ePaper Display Board (EE02), backed by a Cloudflare Worker.

## So what does this project do

Replaces the Seeed factory-installed firmware on the EE02 board with custom firmware that:

1. Connects to your WiFi network
2. Wakes up from deep sleep to fetch an image from a Cloudflare Worker you deploy to your own Cloudflare account
3. Displays the image on a Spectra 6 e-ink screen
4. Goes back to sleep to conserve battery (sleep interval is configurable)
5. Skips wakeups during configurable quiet hours (like overnight when no one is seeing the display)
6. Wakes up periodically to check for new images and only refreshes the image if it has changed
7. Can update its own firmware over the air, with automatic rollback if a bad build fails to boot or never proves itself healthy

There is no local Python server or filesystem-based image folder anymore — every device, image, schedule, and firmware target is managed through the Worker's `/admin` dashboard and stored in Cloudflare D1/KV.

---

## Architecture

```
┌───────────────────────┐              ┌─────────────────┐
│   Cloudflare Worker    │              │   EE02 Board    │
│  (Hono + D1 + KV)       │              │ Arduino Firmware │
│                         │              │                 │
│  GET /device_config     │◄─────────────│ (wake from deep │
│  GET /hash               │              │  sleep)         │
│  GET /image_packed       │─────────────►│                 │
│  GET /firmware_bin        │              │ Display image   │
│  POST /crash_report       │◄─────────────│ (dual-controller│
│                         │              │  SPI)           │
│  /admin (dashboard)      │              │                 │
│  /provision (BLE setup)  │              │ Deep sleep      │
└───────────────────────┘              └─────────────────┘
```

- The **Worker** (`worker/`) is the entire backend: device registry, per-device image buckets (with server-side dithering to the 6-color palette), schedules/quiet hours, firmware catalog + rollout targets, and crash report collection. It's deployed to your own Cloudflare account.
- The **firmware** (`firmware/`) runs on the ESP32-S3 and talks to the Worker over plain HTTPS, authenticated per-request with an HMAC device signature (not the admin API key).
- Accounts are passkey-only (Face ID / Touch ID / Windows Hello / security key) — there's no email or password anywhere in this system.

See `worker/openapi.yaml` for the full API reference (importable into Postman/Insomnia/Swagger UI).

---

## What's required

- Node.js and npm
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the Worker needs D1, KV, and a paid Workers plan — see "Deploy the Worker" below for why)
- [PlatformIO](https://platformio.org/) (CLI or VSCode extension)
- A Seeed EE02 / XIAO ePaper board with a 13.3" Spectra 6 panel
- A USB-C data cable
- A 2.4 GHz WiFi network
- Chrome or Edge (desktop or Android) for the Bluetooth provisioning page — Web Bluetooth isn't supported in Safari/iOS

---

## Step-by-Step Setup Guide

### Step 1: Deploy the Cloudflare Worker

The Worker is the server half of this project — it replaces what used to be a local Python script.

```bash
cd worker
npm install
npx wrangler login
```

Create the resources the Worker needs, then wire their ids into `wrangler.toml`:

```bash
npx wrangler d1 create eink
npx wrangler kv namespace create eink-kv
```

Edit `worker/wrangler.toml`'s top-level `[[d1_databases]]` and `[[kv_namespaces]]` blocks with the `database_id` / `id` values those commands print (the `[env.local]` block underneath is for local dev only — leave its dummy ids alone).

Apply the database schema and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

`npm run deploy` prints your Worker's URL (`https://<name>.<subdomain>.workers.dev`, or your own custom domain if you've attached one). Note it — you'll need it during device provisioning.

`npm run deploy` also prints a code-integrity record (an `INTEGRITY-RECORD ...` line: this deploy's git commit and the SHA-256 of the client bundles it just built — see root `CLAUDE.md`'s "Encrypted Image Buckets" section) and appends it to `worker/dist-hashes.log`. If you're deploying manually like this, **commit and push that file afterward** — an uncommitted log entry isn't part of the record it exists to provide. If instead you've connected this repo to Cloudflare Workers Builds for git-triggered deploys, that manual step doesn't apply: Cloudflare's own retained build log for each deployment (which prints this same line) is the actual record, immutably tied to the commit that triggered it — nothing to remember to commit.

**Note:** `/admin/images/upload` does server-side image decoding and dithering, which is CPU-heavy enough that it needs the higher `cpu_ms` limit set in `wrangler.toml` — that only works on a paid Workers plan, not the free tier.

**Optional:** for automatic OTA firmware cataloging from GitHub releases, set a `GITHUB_TOKEN` secret:

```bash
npx wrangler secret put GITHUB_TOKEN
```

Without it, you can still sync releases manually from `/admin`'s Firmware panel.

### Step 2: Create Your Account

Open your deployed Worker's URL in a browser, click **Open Admin Dashboard**, then **Create account** and follow your browser/OS prompt to create a passkey. That passkey *is* your account — there's no separate signup form. Save the API key shown once if you want scripted (non-browser) access to the admin API; otherwise you can always log back in with the same passkey.

### Step 3: Build the Firmware

```bash
cd firmware
pio run -e ee02-13in3
```

The first build takes several minutes as it downloads the ESP32 compiler and libraries. Subsequent builds are much faster. Nothing needs editing before this build — WiFi and server settings are provisioned at runtime, not compiled in.

### Step 4: Connect and Flash the EE02 Board

1. Connect the EE02 board via USB-C. **Note:** if nothing seems to happen, your cable might be charge-only.
2. Check the port is detected:
   - Linux: `ls /dev/ttyACM*`
   - macOS: `ls /dev/cu.usb*`
3. You may need to press the reset button on the board to get it into a state PlatformIO can flash.
4. Flash:
   ```bash
   pio run -e ee02-13in3 -t upload --upload-port /dev/ttyACM0   # adjust the port
   ```

### Step 5: Provision WiFi and the Server Address (Bluetooth)

A freshly flashed board has no WiFi credentials saved, so it boots straight into Bluetooth setup mode advertising itself as `EInk-Setup`.

1. From Chrome or Edge, open `https://<your-worker-url>/provision` and click **Connect to device**.
2. Pick `EInk-Setup` from the browser's device picker.
3. Fill in your WiFi network/password, and the server host (your Worker's hostname), port `443`, and check **Use HTTPS**. Leave the other fields at their defaults unless you want a different refresh interval or active hours.
4. Click **Save & Reboot**.

### Step 6: Register the Device

An unregistered board's display shows a QR code plus its MAC address instead of your photos.

1. Scan the QR code with your phone (or manually open `/admin?claim=<mac>` in a browser). This opens the admin dashboard with the device's MAC (and a one-time registration secret) pre-filled.
2. Log in with your passkey if you aren't already, then confirm registration.

The device now belongs to your account and is ready to display images.

### Step 7: Upload Images

From `/admin`:

1. Create a bucket (a named image collection) if you don't already have one, and assign it to your device.
2. Upload photos — JPEG, PNG, WebP, GIF, or BMP (**not** HEIC; convert iPhone photos to JPEG first). The Worker handles EXIF rotation, cropping, and dithering to the 6-color palette server-side.
3. Images rotate in upload order each time the device wakes and its hash check shows a change.

### Step 8: Test the Display

Press the reset button on the EE02 board. It should:

1. Connect to WiFi (a few seconds)
2. Fetch its config, schedule, and image hash from the Worker
3. Download and display the image if it changed (usually 20-30 seconds of flickering)
4. Go back to sleep

**Congratulations!** Your e-ink display should be showing your image.

Optionally, set per-device quiet hours and refresh interval from `/admin`'s schedule editor.

---

## Monitoring what's happening (serial output)

The ESP32 sends debug information over USB. Mainly helpful for troubleshooting.

### Using `screen` (Linux/macOS) or whatever you'd prefer

```bash
screen /dev/ttyACM0 115200
```

Press reset on the board to see output.

### Using PlatformIO Monitor

```bash
cd firmware
pio device monitor --port /dev/ttyACM0 --baud 115200
```

### Following logs across deep sleep

The USB serial device disappears when the board enters deep sleep, so a single `pio device monitor` session usually stops after the first sleep cycle. This loop reattaches each time the board wakes up:

```bash
cd firmware
while true; do
  pio device monitor --port /dev/ttyACM0 --baud 115200
  sleep 1
done
```

### What You'll See

Normal operation looks like this:
```
========================================
Seeed EE02 E-Ink Display Firmware
========================================
Boot count: 1

========================================
NORMAL OPERATION MODE
========================================

Battery: ADC=2413, voltage=4.21V
Connecting to WiFi: YourNetwork
.
Connected! IP: 192....
Fetching device config from: https://your-worker.workers.dev/device_config
Checking image hash at: https://your-worker.workers.dev/hash
Sending X-Device-MAC: d0cf1326f7e8
Last known hash: (none)
Server hash: 942d3cfc05c8fa41
Image changed - will download new image
Fetching image from: https://your-worker.workers.dev/image_packed
Content length: 960000 bytes
Downloaded 960000 bytes in 10395 ms
Spectra6: Starting display refresh...
Spectra6: Refresh complete in 28432 ms
WiFi disconnected
Entering deep sleep for 15 minutes...
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
Entering deep sleep for 15 minutes...
```

---

## Changing Settings Without Reflashing

WiFi credentials, the server address, sleep interval, and other settings can all be changed without reflashing — over Bluetooth LE, not a web server hosted by the board.

### Entering Configuration Mode

1. Hold Button 1 (GPIO2 — the button closest to the USB connector)
2. While holding Button 1, press and release the reset button
3. Continue holding Button 1 for an additional second
4. Release Button 1 — the device enters configuration mode

A device with no WiFi credentials saved yet (e.g. right after first flashing) enters configuration mode automatically — no button needed.

### Using the Bluetooth Configuration Interface

Open `/provision` on your Worker from Chrome or Edge, click **Connect to device**, select `EInk-Setup`, and update any of:

- **WiFi Network / Password** — use "Scan" to list nearby networks
- **Server Host / Port / Use HTTPS** — your Worker's hostname
- **Image Endpoint** — usually `/image_packed`
- **Refresh Interval** — how often to check for new images during active hours (1-1440 minutes)
- **Active Start / End Hour** — local wall-clock active window
- **Timezone Offset** — minutes from UTC for local scheduling

Click **Save & Reboot**.

---

## Multiple boards, images, schedules, and firmware rollout

Everything below is per-device, managed from `/admin`. There's deliberately no shared "apply to every device" toggle for images, schedules, or firmware — each device (or bucket of images) is configured on its own, and multiple people can be invited to collaborate on a shared bucket via an invite link.

- **Multiple boards:** register as many device MACs as you like under one account, each pointed at its own bucket (or sharing one).
- **Shared buckets:** an owner can generate an invite link (`/admin/buckets/{id}/invite`) so a collaborator's account gets read/write access to the same image collection without owning it.
- **Schedules:** set per-device refresh interval, active hours, and timezone offset from the schedule editor; clearing an override falls back to the firmware's own locally stored defaults.
- **OTA firmware:** see `CLAUDE.md`'s "OTA Firmware Updates" section for the full release → catalog → per-device target flow, and its rollback safety model.

---

## Troubleshooting

### "No such file or directory: /dev/ttyACM0"

The device isn't detected. Try:
1. **Different USB cable** — this is the most common issue! Many cables are charge-only.
2. **Press the reset button** — the device may be in deep sleep.
3. **Check the port name** — run `ls /dev/ttyACM*` (Linux) or `ls /dev/cu.usb*` (macOS).

### WiFi won't connect

- Make sure your network is **2.4GHz**.
- Re-enter Bluetooth config mode (hold Button 1 during reset) and re-provision the SSID/password from `/provision` — WiFi credentials live in NVS, set over Bluetooth, not in `firmware/src/ee02/config.h`.

### "HTTP GET failed" / device can't reach the server

1. Confirm the Worker is deployed and reachable: `curl https://your-worker.workers.dev/`
2. Double check the host/port/HTTPS settings saved during provisioning.
3. If using a plain-HTTP local dev server (`npm run dev` inside `worker/`) instead of a deployed Worker, make sure **Use HTTPS** is unchecked and the board and your dev machine are on the same network.

### Device shows a QR code instead of my photos

The MAC is unregistered (or was unregistered again after a delete). Scan the QR code, or open `/admin?claim=<mac>` manually, to claim it.

### The server is reachable, but image updates feel slow

- This display is inherently slow to refresh. A full refresh often takes 20-30 seconds.
- The Worker also needs time to decode, dither, and pack a newly uploaded source image — this happens once at upload time, not on every device fetch, so subsequent wakeups are fast.

---

## File Structure

```
eink_pictureframe/
├── README.md              # This file
├── firmware/               # ESP32 firmware
│   ├── platformio.ini       # Build configuration
│   ├── README.md            # Detailed firmware documentation
│   └── src/
│       ├── config.h            # Pin definitions and non-secret defaults
│       ├── config_manager.h/.cpp  # NVS-persisted configuration, incl. WiFi creds
│       ├── ble_provisioning.h/.cpp  # Bluetooth LE configuration interface
│       ├── display.h/.cpp      # Spectra 6 display driver
│       ├── ota_health.h/.cpp   # OTA rollback / crash reporting
│       └── main.cpp            # Main loop: WiFi, fetch, display, deep sleep
└── worker/                 # Cloudflare Worker backend (Hono + D1 + KV)
    ├── wrangler.toml          # Deployment config (D1/KV bindings, cron trigger)
    ├── openapi.yaml           # Full API reference
    └── src/
        ├── index.ts              # Route registration + scheduled() cron handler
        ├── admin-ui.ts / provision-ui.ts / landing-ui.ts  # Server-rendered pages
        ├── routes/               # Device-facing and /admin/* endpoints
        ├── lib/                  # Dithering, rotation, auth, schedules, OTA, etc.
        └── db/migrations/        # D1 schema migrations
```

---

## Battery Monitoring

The firmware reads battery voltage once per boot (before WiFi, to avoid ADC noise) and sends it to the Worker via the `X-Battery-Voltage` header on every request. The Worker records the latest value per device and shows it in `/admin` and the `/current` status endpoint.

| Voltage | Capacity | Status |
|---------|----------|--------|
| 4.2V+   | Full (or on USB) | GOOD |
| 3.7V    | ~50% | GOOD |
| 3.3V    | ~10% | LOW |
| 3.0V    | Empty (cutoff) | LOW |

---

## Credits

- Firmware display driver inspired by [esphome-bigink](https://github.com/acegallagher/esphome-bigink)
