# Device Simulator

A native (Mac, SDL2-windowed) build of the real firmware — not a
reimplementation. `make BOARD=ee02` compiles `firmware/lib/common/*.cpp` and
the chosen board's `display.cpp`/`main.cpp` **directly**, unmodified, against
stub headers standing in for the Arduino/ESP32/NimBLE APIs. It talks to a
**local** `wrangler dev` instance by default — never point it at production.

Modeled on `~/git/epaper_clock/simulator/`'s Makefile+stubs+SDL2 approach,
with three things that project didn't need: real HTTP (there's a real Worker
to hit), real HMAC request signing (via macOS CommonCrypto), and a way to
exercise real BLE provisioning without real Bluetooth (see "How provisioning
works" below).

## Launching the simulator

**Terminal 1** — start a local Worker for the simulator to talk to (never
point the simulator at production):

```bash
cd worker
npm install
npm run dev          # wrangler dev on http://localhost:8787
```

**Terminal 2** — build and run one (or both) boards. `package.json` here is
just a thin wrapper around the Makefile, for anyone who'd rather not type
`make`/`./sim-<board>` directly:

```bash
cd firmware/simulator

npm run start:ee02   # == make BOARD=ee02 && ./sim-ee02

# in a separate terminal/pane, the other board can run at the same time:
npm run start:ee04   # == make BOARD=ee04 && ./sim-ee04
```

| npm script      | Equivalent                  |
| ---------------- | ---------------------------- |
| `build:ee02`      | `make BOARD=ee02`             |
| `build:ee04`      | `make BOARD=ee04`             |
| `start:ee02`      | `make BOARD=ee02 && ./sim-ee02` |
| `start:ee04`      | `make BOARD=ee04 && ./sim-ee04` |
| `clean`            | `make clean`                   |

These don't take extra arguments — for `--server`/`--reset`/`--export` (see
"Flags" below), build once via `npm run build:ee02` then run the binary
directly: `./sim-ee02 --export snapshot.jpg`.

Each board has its own binary, its own persisted state (`.state/ee02/` /
`.state/ee04/`), and its own fixed simulated MAC, so both can run against
the same local Worker simultaneously without colliding.

On first run (or after `--reset`) there's no WiFi configured, so it boots
straight into config mode — same as real hardware — and prints a
`/provision?sim=...` URL. Open that in Chrome or Edge: it's the *real*
`/provision` page, just talking to this simulator's fake GATT-over-HTTP
server (see below) instead of real Web Bluetooth. Fill in the form (host
`localhost`, port `8787`, HTTPS unchecked) and save.

A window opens showing whatever the real `display.cpp` last wrote to its
pixel buffer — the config-mode banner, the "scan to register" QR screen, or
(once registered and a bucket has images) the actual dithered photo. Press
**Space** in that window to wake early instead of waiting out the real
refresh interval (capped at 5s either way so the window stays responsive);
closing the window exits the process.

An unregistered device also prints its claim URL directly to the terminal
(`/admin?claim=<mac>&secret=<hex>`) — there's no camera here to scan the QR
code with.

## Flags

```
./sim-ee02 [--server <url>] [--reset] [--export <path.jpg>]

--server   Base URL of the worker to hit. Default: http://localhost:8787
           (a local wrangler dev instance). Applied every run, overriding
           whatever was previously saved — config_manager.h's own compiled-in
           default points at production, which this must never hit by accident.
--reset    Wipe this board's persisted state (.state/<board>/) - like a
           fresh, unprovisioned flash.
--export   Headless mode: run exactly one boot cycle, save whatever the
           display buffer holds afterward as a numbered JPEG
           (<path-without-ext>_01.jpg, matching
           ~/git/epaper_clock/simulator/EPaperSim.h's scheme), then exit -
           no SDL window/WindowServer needed at all. Useful over SSH/CI, or
           for scripting a single snapshot without babysitting a live
           window. Only captures what a *completed* setup() cycle leaves on
           the buffer, so it won't produce anything for a device stuck
           waiting in config mode for a save (see "Known limitations").
```

`make BOARD=ee04` builds the other board the same way; each has its own
persisted state and fixed simulated MAC, so `./sim-ee02` and `./sim-ee04` can
run at once against the same local wrangler instance.

## How provisioning works

Real BLE provisioning (`firmware/lib/common/ble_provisioning.cpp`) is
compiled in unmodified. There's no way to run a real BLE peripheral from a
Mac process, so `stubs/NimBLEDevice.h` routes its NimBLE calls through
`gatt_bridge.cpp` — a small background-thread HTTP+SSE server exposing
`GET /gatt/info`, `GET /gatt/events` (SSE), `POST /gatt/config`,
`POST /gatt/command` on port 8790. `worker/src/client/provision.ts`'s real
`/provision` page already speaks this exact contract via its `?sim=<origin>`
query param, so the same browser page you'd use for real hardware works here
unchanged, clicking through the same save → the real `ble_provisioning.cpp`
processes it → the real `ESP.restart()` fires. Since a real restart never
returns and this is one long-lived process rather than real hardware, that
(and every other "reboot" — deep sleep, a forced OTA rollback) throws a small
`RebootSignal` instead, caught by `main_native.cpp`'s outer loop, which then
calls `setup()` again — the closest native equivalent to a real reset.

## Known limitations

- **`--export` on an unprovisioned device.** Config mode blocks inside
  `runConfigMode()`'s real `while (true)` loop until a save arrives over the
  GATT bridge - `setup()` never returns on its own, so `--export` never gets
  a chance to run and just hangs. Provision the device normally first (or
  reuse an already-provisioned `.state/`), then use `--export` for
  normal-mode/registration-screen snapshots.
- **EE04 image geometry.** The Worker's `/image_packed` always returns an
  EE02-sized (1600×1200) buffer regardless of `X-Device-Board` — a
  pre-existing, not-yet-started effort (see root `CLAUDE.md`). `--board ee04`
  faithfully reproduces the resulting "content length exceeds buffer size"
  failure real EE04 hardware hits today, through the real firmware code path
  — this isn't a simulator bug to fix here.
- **No OTA / crash-report exercise.** `stubs/Update.h`'s `begin()` always
  returns false, so an OTA download never actually runs (device_app.h treats
  that as "continue with current firmware," same as a real failed download).
  `/crash_report` is never triggered either — there's nothing to crash.
- **No real WiFi scan.** `stubs/WiFi.h`'s "scan" returns three fixed fake
  networks after a short delay.
- **macOS only.** `stubs/mbedtls/*.h` wrap CommonCrypto directly, matching
  this project's one dev machine — the same scope assumption epaper_clock's
  Homebrew SDL2 paths already make.
- **Small per-"reboot" memory leak.** `display.cpp`'s `begin()` allocates a
  fresh buffer every cycle without freeing the previous one — harmless on
  real hardware (deep sleep wipes RAM, so there never is a previous one) but
  a real, if slow, leak here across many manual wakes in one long-running
  session. Not worth fixing at the cost of touching `display.cpp` itself.
