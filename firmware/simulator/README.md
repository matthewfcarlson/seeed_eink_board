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

Each board has its own binary, its own persisted state, and its own
simulated MAC, so both can run against the same local Worker simultaneously
without colliding. Both the MAC and the state directory are derived from
the running binary's own Mach-O LC_UUID (locally-administered MAC,
`02:...`; state directory `.state/<board>-<uuid>/`) — a fresh value on
every rebuild, even of unchanged source, standing in for swapping in a
distinct physical unit rather than reflashing the same one. That's also
what keeps two instances of the *same* board from colliding: every
`make run-<board>` relinks first, so rebuilding-and-rerunning while an
earlier instance of that board is still alive lands the new one on its own
fresh, empty directory instead of the live one's. As a second layer against
the one case that can't rule out on its own — two instances of the exact
same already-built binary launched at once, with no rebuild in between —
each instance takes an exclusive lock on its state directory at startup;
a second one that can't get the lock refuses to start with an explanatory
message instead of racing the first over the same NVS files.

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
./sim-ee02 [--server <url>] [--reset] [--export <path.jpg>] [--wifi <ssid>]

--server   Base URL of the worker to hit. Default: http://localhost:8787
           (a local wrangler dev instance). Applied every run, overriding
           whatever was previously saved — config_manager.h's own compiled-in
           default points at production, which this must never hit by accident.
--reset    Wipe this build's persisted state (.state/<board>-<uuid>/) - like
           a fresh, unprovisioned flash. Only ever this exact binary's own
           directory, never a sibling instance's (see above).
--export   Headless mode: run exactly one boot cycle, save whatever the
           display buffer holds afterward as a numbered JPEG
           (<path-without-ext>_01.jpg, matching
           ~/git/epaper_clock/simulator/EPaperSim.h's scheme), then exit -
           no SDL window/WindowServer needed at all. Useful over SSH/CI, or
           for scripting a single snapshot without babysitting a live
           window. Only captures what a *completed* setup() cycle leaves on
           the buffer, so it won't produce anything for a device stuck
           waiting in config mode for a save (see "Known limitations").
--wifi     Test-automation-only shortcut: sets WiFi credentials directly via
           ConfigManager::setWifiCredentials(), skipping config mode/BLE
           provisioning entirely. Real hardware only ever gets WiFi
           credentials over Bluetooth (see "How provisioning works" below);
           this exists so a scripted e2e test (see "End-to-end tests" below)
           doesn't have to speak the GATT-over-HTTP contract just to get a
           device out of config mode. stubs/WiFi.h's begin()/status() ignore
           the credentials' actual content and always report WL_CONNECTED,
           so any non-empty SSID works.
```

`make BOARD=ee04` builds the other board the same way; each has its own
persisted state and simulated MAC (see above), so `./sim-ee02` and
`./sim-ee04` can run at once against the same local wrangler instance.

## Native pipeline tests

`tools/test_gcm_stream.cpp`, `tools/test_tinfl_stream.cpp`, and
`tools/test_decrypt_inflate_pipeline.cpp` verify the real production
crypto/decompression pipeline (`firmware/lib/common/device_app.h`'s
`decryptChunksInflate()`, `firmware/lib/common/tinfl.{h,c}`, and
`stubs/mbedtls/gcm.h`'s streaming GCM) against ground truth generated by
Node's own `crypto.subtle` and `zlib` — not a reimplementation of either. See
each test file's own header comment for what it checks and why.

Run everything (regenerates fixtures fresh, then builds and runs all three):

```bash
npm test        # or: make test
```

`npm start:ee02`/`start:ee04` (→ `make run`) run this first and abort before
launching the simulator if anything fails — see the Makefile's `run: test
all` — so a broken crypto/inflate pipeline is caught before you're staring
at a stuck display, not discovered mid-session. Fixture generators
(`tools/gen_gcm_vectors.mjs`, `gen_tinfl_vectors.mjs`,
`gen_combined_vectors.mjs`) and their output directories
(`tools/gcm_vectors/`, `tools/vectors/`, `tools/combined_vectors/`) are
gitignored — regenerated fresh on every run, not checked in.

## End-to-end tests

`worker/test/e2e/registration-and-image-flow.test.ts` drives this simulator
from Node (via `child_process`, not a browser) against a real, throwaway
`wrangler dev` instance to exercise the full self-registration + encrypted-
image-display flow described in root CLAUDE.md: unclaimed boot → QR
registration screen → claim → create a bucket + upload an image → assign the
bucket to the device → device fetches/decrypts/displays it. It builds this
directory's `sim-ee02` binary itself (`worker/test/e2e/lib/simulator.ts`),
so it needs this directory's own build prerequisites (macOS, SDL2, clang++)
in addition to Node - run it with `npm run test:e2e` from `worker/`, not as
part of the default `npm test`. It uses `--wifi` (see "Flags" above) to skip
BLE provisioning, and a virtual software WebAuthn authenticator
(`worker/test/e2e/lib/virtual-authenticator.ts`) to create an admin account
without a browser, since a real passkey ceremony is the only way in
(`worker/src/routes/auth-passkey.ts`). Every other piece of admin-side
crypto (bucket key generation, ECIES wrapping for the device) calls the real
`worker/src/client/crypto.ts` functions, not a re-implementation.

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
- **`RTC_DATA_ATTR` doesn't survive across separate `--export` process
  invocations.** Real deep sleep keeps RAM (and so `RtcState`) powered; so
  does staying in this simulator's own single long-running process (its
  outer loop just calls `setup()` again - see "How provisioning works"
  above). But each `./sim-ee02 ... --export x.jpg` run is a fresh OS
  process, closer to a real power-cycle than a deep-sleep wake - a script
  that calls it repeatedly (see "End-to-end tests" above) will see
  `rtc.lastImageHash` reset every time, so it can exercise the
  known_hash/304 change-detection path's *server* side but not observe the
  device skipping a re-download because of it.
- **macOS only.** `stubs/mbedtls/*.h` wrap CommonCrypto directly, matching
  this project's one dev machine — the same scope assumption epaper_clock's
  Homebrew SDL2 paths already make.
- **Small per-"reboot" memory leak.** `display.cpp`'s `begin()` allocates a
  fresh buffer every cycle without freeing the previous one — harmless on
  real hardware (deep sleep wipes RAM, so there never is a previous one) but
  a real, if slow, leak here across many manual wakes in one long-running
  session. Not worth fixing at the cost of touching `display.cpp` itself.
