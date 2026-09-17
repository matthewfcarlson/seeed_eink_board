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
#include <pthread.h>
#include <string>
#include <thread>
#include <unistd.h>

#include "stubs/Arduino.h"
#include "stubs/RebootSignal.h"
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
    DisplayRender::present(display.getBuffer(), display.getBufferSize(), DISPLAY_WIDTH, DISPLAY_HEIGHT);
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

    if (doReset) {
        // .state/<SIM_STATE_DIR>/ is this board's whole persisted state (see
        // stubs/Preferences.h) - a per-board literal baked in by the
        // Makefile, safe to shell out against directly.
        std::string cmd = std::string("rm -rf .state/") + SIM_STATE_DIR;
        system(cmd.c_str());
        printf("Reset: wiped persisted state for board %s\n", SIM_STATE_DIR);
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
    printf("  Talking to: %s\n", serverUrl.c_str());
    printf("  Provision:  %s/provision?sim=http://localhost:%d\n", serverUrl.c_str(), SIM_GATT_PORT);
    printf("  Space in the display window wakes early; closing it quits.\n\n");

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
