// Native simulator entry point - the counterpart to each board's own
// firmware/src/<board>/main.cpp. #includes the REAL board main.cpp directly
// (mirrors ~/git/epaper_clock/simulator/main.cpp's approach) so its actual
// setup()/loop() run unmodified; every Arduino/ESP32 header it and its own
// #includes reach for resolves to firmware/simulator/stubs/ instead (see the
// Makefile's -I order). See README.md for the full design rationale.

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <pthread.h>
#include <string>
#include <sys/file.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

#include "stubs/Arduino.h"
#include "stubs/RebootSignal.h"
#include "stubs/WiFi.h"
#include "stubs/esp_sleep.h"
#include "display_render.h"
#include "gatt_bridge.h"

// Declared extern in stubs/esp_sleep.h; esp_sleep_enable_timer_wakeup() sets
// it, read below to decide how long to pause between simulated boot cycles.
uint64_t g_sleep_us = 0;

// Ctrl+C (SIGINT) not killing the running simulator was reported as a real
// bug (not just a rough edge): launching this binary as a shell background
// job (`./sim-ee02 &`, or the equivalent a Makefile `run` target's child
// process ends up as) has SIGINT's disposition set to SIG_IGN by the shell's
// own job control *before* main() ever runs - standard behavior so Ctrl+C in
// a terminal doesn't kill backgrounded jobs out from under you. POSIX says a
// signal generated while its disposition is SIG_IGN is discarded immediately,
// before pending/blocked-set semantics even come into play - so merely
// blocking SIGINT and waiting on it (sigwait()) is not enough on its own;
// the signal has to actually not be ignored at the moment it's sent, or it
// never becomes pending for anything to catch. Confirmed both ways with
// isolated repros outside this codebase - plain sigwait() without resetting
// the disposition first stayed unkillable, resetting it fixed it.
//
// The fix here: reset the disposition away from SIG_IGN, then block the
// signal set on the main thread before any other thread is created (every
// thread spawned afterward - SDL's internal ones, GattBridge's, BLE's -
// inherits this mask at creation), and consume it via a dedicated sigwait()
// thread rather than a normal handler function, since a handler would still
// have to not get its disposition stomped by anything spawned later.
static void installSignalWatcher() {
    // Must happen before the sigmask block below - see comment above.
    signal(SIGINT, SIG_DFL);
    signal(SIGTERM, SIG_DFL);

    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGINT);
    sigaddset(&set, SIGTERM);
    pthread_sigmask(SIG_BLOCK, &set, nullptr);
    std::thread([set]() mutable {
        int sig = 0;
        sigwait(&set, &sig);
        // Best-effort: closes GattBridge's listener socket/thread cleanly.
        // Not essential for correctness - the OS reclaims sockets/threads on
        // process exit regardless - but tidy while it's cheap to do.
        GattBridge::stop();
        _exit(0);
    }).detach();
}

#ifndef BOARD_MAIN_CPP
#error "BOARD_MAIN_CPP must be set by the Makefile, e.g. -DBOARD_MAIN_CPP=\"../src/ee02/main.cpp\""
#endif
#include BOARD_MAIN_CPP
// From here on, `display`, `configManager`, DISPLAY_WIDTH/DISPLAY_HEIGHT,
// BOARD_ID, and setup()/loop() are all in scope - they're globals/macros/
// functions defined by the #include above.

static void renderCurrentBuffer() {
    DisplayRender::present(display.getBuffer(), display.getBufferSize(), DISPLAY_WIDTH, DISPLAY_HEIGHT, DISPLAY_MOUNTED_ROTATED);
}

// stubs/Arduino.h's delay() calls this on every invocation - the only way a
// long-running loop that never returns to main()'s own renderCurrentBuffer()
// call (chiefly runConfigMode()'s BLE loop, but this also just generally
// keeps the window responsive during any other multi-second stretch, like a
// WiFi retry) still shows what's actually in the buffer instead of leaving
// the window frozen on whatever was last presented. Throttled to ~10Hz since
// present() repacks the whole buffer to RGB every call - cheap for the
// common case (a single millis() comparison) even though delay() itself is
// called very frequently (e.g. every 10ms inside the BLE loop, or a handful
// of times per waitUntilIdle() spin during a real display refresh).
void simPumpDisplay() {
    // No SDL window/event queue exists in export mode - present() would just
    // write a new numbered JPEG on every throttled tick for as long as the
    // device sits in a loop like config mode, and pollWakeOrQuit() explicitly
    // isn't safe to call at all then (see its own doc comment). Export mode
    // already gets one clean frame from main()'s own renderCurrentBuffer()
    // call after the first setup() cycle returns (or, for a device that
    // boots into config mode, none at all yet - a separate, narrower gap
    // than this fix, since export mode's whole point is one boot then exit).
    if (DisplayRender::isExportMode()) return;

    static unsigned long lastPumpMs = 0;
    unsigned long now = millis();
    if (now - lastPumpMs < 100) return;
    lastPumpMs = now;

    if (display.getBuffer() != nullptr) {
        DisplayRender::present(display.getBuffer(), display.getBufferSize(), DISPLAY_WIDTH, DISPLAY_HEIGHT, DISPLAY_MOUNTED_ROTATED);
    }

    // Also keeps the window responsive (macOS otherwise flags an SDL window
    // that never pumps events as "not responding") during any stretch this
    // long. Discards the "wake" return value deliberately - "Space wakes
    // early" is only meaningful against the actual sleep-pause loop below,
    // which does its own pollWakeOrQuit() call; a Space press consumed from
    // here (e.g. during config mode, or mid-WiFi-connect) has no real-hardware
    // analogue to wake early from, same as how real hardware has no input at
    // all at those points.
    bool quit = false;
    DisplayRender::pollWakeOrQuit(&quit);
    if (quit) {
        printf("Window closed - exiting.\n");
        GattBridge::stop();
        exit(0);
    }
}

// Builds the same claim URL worker/src/lib/registration-url.ts constructs
// server-side (origin + "/admin?claim=<mac>&secret=<hex>") - the simulator
// has no camera to scan its own QR code with, so print it directly instead.
static void printRegistrationUrlIfUnclaimed() {
    if (configManager.getDeviceRegistered()) return;
    const char *scheme = configManager.getUseHttps() ? "https://" : "http://";
    printf("Not yet registered - claim this device: %s%s:%d/admin?claim=%s&secret=%s\n",
           scheme, configManager.getServerHost().c_str(), configManager.getServerPort(),
           DeviceApp::getMACAddressClean().c_str(), configManager.getDeviceSecret().c_str());
}

// This board's simulated MAC (stubs/WiFi.h's SimMac::buildMacAddress()) and
// its persisted-state directory are both derived from the running binary's
// own Mach-O UUID, which changes on every rebuild - standing in for swapping
// in a distinct physical unit rather than reflashing the same one. Every
// `make run-<board>` relinks first (a fresh UUID even for unchanged source
// - see SimMac::buildIdentityHex()), so basing the state directory's name on
// that UUID means a rebuild naturally lands on its own brand-new, empty
// directory instead of reusing - and potentially colliding with, if an
// earlier instance for this same board is still running - the previous
// one. (An earlier version of this used one shared `.state/<board>/`
// directory plus a stamped marker file, wiping the whole thing whenever the
// identity didn't match - which let a second `make run-<board>` invocation
// silently delete a still-running first instance's state mid-run, with no
// log line in the first instance's own terminal to explain why. Observed in
// practice, not hypothetical.)
static std::string boardStateDir() {
    return std::string(SIM_STATE_DIR) + "-" + SimMac::buildIdentityHex().substr(0, 12);
}

// Belt-and-suspenders against the one collision boardStateDir() can't rule
// out on its own: two instances of this exact already-built binary (no
// rebuild in between, so identical UUID/state dir) launched at once. An
// exclusive flock on a lockfile *sibling to*, not inside, the state
// directory - so a --reset's rm -rf of the directory never touches the fd
// this holds open - makes the second one refuse to start instead of racing
// the first over the same NVS files.
static void acquireBoardLockOrExit(const std::string &stateDir) {
    mkdir(".state", 0755);
    std::string lockPath = std::string(".state/") + stateDir + ".lock";
    int fd = open(lockPath.c_str(), O_CREAT | O_RDWR, 0644);
    if (fd < 0) return;  // unwritable .state/ - not fatal, just no safety net
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        fprintf(stderr,
                "Another simulator instance is already using .state/%s/ "
                "(same board, same build) - stop it first.\n",
                stateDir.c_str());
        exit(1);
    }
    // Leak the fd deliberately: the lock must live for the whole process
    // lifetime, and it's released automatically on exit (normal or crash).
}

// "026f5bca3072" -> "02:6f:5b:ca:30:72", matching the colon-separated form
// everything else (System Settings, `arp`, real hardware labels) shows a
// MAC in - getMACAddressClean() itself stays separator-free since that's
// the form the HMAC signing / X-Device-MAC header need.
static std::string formatMacWithColons(const std::string &clean) {
    std::string out;
    for (size_t i = 0; i < clean.size(); i += 2) {
        if (i) out += ':';
        out += clean.substr(i, 2);
    }
    return out;
}

// Applies --server (default: local wrangler dev) every run, overriding
// whatever was previously persisted - config_manager.h's own compiled-in
// defaults point at production (eink.matthewc.dev), which the simulator must
// never hit by accident.
static void applyServerFlag(const std::string &serverUrl) {
    bool useHttps = serverUrl.rfind("https://", 0) == 0;
    std::string rest = serverUrl.substr(useHttps ? 8 : 7);
    std::string host = rest;
    int port = useHttps ? 443 : 80;
    auto colon = rest.find(':');
    if (colon != std::string::npos) {
        host = rest.substr(0, colon);
        port = atoi(rest.c_str() + colon + 1);
    }
    configManager.setServerHost(host.c_str());
    configManager.setServerPort((uint16_t)port);
    configManager.setUseHttps(useHttps);
}

int main(int argc, char **argv) {
    installSignalWatcher();

    std::string serverUrl = "http://localhost:8787";
    bool doReset = false;
    std::string exportPath;
    std::string wifiSsid;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--server") == 0 && i + 1 < argc) {
            serverUrl = argv[++i];
        } else if (strcmp(argv[i], "--reset") == 0) {
            doReset = true;
        } else if (strcmp(argv[i], "--export") == 0 && i + 1 < argc) {
            exportPath = argv[++i];
        } else if (strcmp(argv[i], "--wifi") == 0 && i + 1 < argc) {
            wifiSsid = argv[++i];
        } else {
            fprintf(stderr, "Usage: %s [--server <url>] [--reset] [--export <path.jpg>] [--wifi <ssid>]\n", argv[0]);
            return 1;
        }
    }

    if (!exportPath.empty()) {
        // Same numbered-JPEG scheme as epaper_clock's simulator (see
        // display_render.cpp) - no SDL window is opened at all in this mode.
        DisplayRender::setExportPath(exportPath.c_str());
    }

    // Every build of this binary gets its own state directory (see
    // boardStateDir() above) - set it before anything touches Preferences,
    // and refuse to start if another live instance already owns it.
    std::string stateDir = boardStateDir();
    g_simStateDir = stateDir;
    acquireBoardLockOrExit(stateDir);

    if (doReset) {
        // This build's own state directory only (see boardStateDir() above)
        // - never a sibling instance's, even one for the same board.
        std::string cmd = std::string("rm -rf .state/") + stateDir;
        system(cmd.c_str());
        printf("Reset: wiped persisted state (.state/%s/)\n", stateDir.c_str());
    }

    configManager.begin();
    applyServerFlag(serverUrl);
    if (!wifiSsid.empty()) {
        // Test-automation-only shortcut: real hardware only ever gets WiFi
        // credentials via BLE provisioning (see ble_provisioning.cpp /
        // gatt_bridge.h) - stubs/WiFi.h's begin()/status() ignore whatever
        // credentials are stored and always report WL_CONNECTED, so any
        // non-empty SSID here is enough to satisfy setup()'s
        // getWifiSsid().length() == 0 config-mode gate without scripting the
        // real GATT-over-HTTP contract in a test harness.
        configManager.setWifiCredentials(wifiSsid.c_str(), "sim-password");
    }

    printf("\nE-Ink device simulator (native) running.\n");
    printf("  Board:      %s\n", BOARD_ID);
    printf("  MAC:        %s\n", DeviceApp::getMACAddressClean().c_str());
    printf("  State dir:  .state/%s/ (unique to this build - rebuilding starts a fresh one)\n", stateDir.c_str());
    printf("  Talking to: %s\n", serverUrl.c_str());
    printf("  Provision:  %s/provision?sim=http://localhost:%d\n", serverUrl.c_str(), SIM_GATT_PORT);
    printf("  Space in the display window wakes early; closing it quits.\n\n");

    // Board + MAC in the window title so it's obvious which simulated device
    // a given window belongs to once more than one is running at once (see
    // boardStateDir() above for how that's now possible without colliding).
    std::string windowTitle = std::string(BOARD_ID) + " - " +
                               formatMacWithColons(std::string(DeviceApp::getMACAddressClean().c_str()));
    DisplayRender::setWindowTitle(windowTitle.c_str());

    if (!DisplayRender::isExportMode()) {
        // Open the window right away with a "BOOTING..." placeholder rather
        // than leaving the user staring at nothing until the first setup()
        // cycle (WiFi connect, provisioning/config sync, image fetch)
        // finishes. Drawn through the board's own Display object (same
        // drawStringPortrait() the config-mode banner in src/<board>/main.cpp
        // uses) rather than a hand-synthesized buffer, so this reuses the
        // real font-rendering code instead of duplicating it here or in
        // display_render.cpp (deliberately buffer-only, no font logic - see
        // its header comment). Colors are the literal nibble values from
        // CLAUDE.md's palette table (0x00 black, 0x01 white), not
        // <board>Color::WHITE/BLACK, since those enum types differ per board
        // and this file is compiled once per board via BOARD_MAIN_CPP.
        // display.begin() runs again inside the first setup() cycle below
        // (and again on every simulated wake after that) - reallocating,
        // and leaking, the previous buffer is already an accepted cost of
        // running many simulated "boots" in one long-lived process; this
        // adds one more instance of that same cost, not a new one.
        if (display.begin()) {
            display.clear(0x01);
            display.drawStringPortrait(20, 20, "BOOTING...", 0x00, 4);
            DisplayRender::present(display.getBuffer(), display.getBufferSize(), DISPLAY_WIDTH, DISPLAY_HEIGHT, DISPLAY_MOUNTED_ROTATED);
        }
    }

    while (true) {
        g_sleep_us = 0;
        try {
            setup();
        } catch (RebootSignal &) {
            // Real esp_deep_sleep_start()/ESP.restart()/
            // esp_ota_mark_app_invalid_rollback_and_reboot() never return
            // either - falls through to render + pause below, standing in
            // for the next real boot.
        }

        renderCurrentBuffer();
        printRegistrationUrlIfUnclaimed();

        if (DisplayRender::isExportMode()) {
            // Mirrors epaper_clock's own export mode: one full boot cycle,
            // then exit - there's no window/event loop to keep alive for.
            GattBridge::stop();
            return 0;
        }

        // Pause standing in for deep sleep: the real requested duration if
        // one was set this cycle (g_sleep_us > 0, from a normal-mode
        // enterDeepSleep()), else immediate (a config-save/OTA-invalidate
        // reboot never calls esp_sleep_enable_timer_wakeup()) - capped so
        // the window stays responsive either way, same shape as
        // epaper_clock's own pause loop.
        uint64_t pauseMs = g_sleep_us / 1000;
        if (pauseMs > 5000) pauseMs = 5000;

        unsigned long start = millis();
        while (millis() - start < pauseMs) {
            bool quit = false;
            bool wake = DisplayRender::pollWakeOrQuit(&quit);
            if (quit) {
                printf("Window closed - exiting.\n");
                GattBridge::stop();
                return 0;
            }
            if (wake) {
                printf("Woken manually (Space pressed).\n");
                break;
            }
            usleep(20000);
        }
    }
}
