#include <Arduino.h>
#include "config.h"
#include "display.h"

#ifdef EE04_BRINGUP_TEST_MODE
// Standalone hardware bring-up: no WiFi, no Worker calls, no BLE, no OTA -
// draws a test pattern once and idles. See firmware/README.md's "EE04 (7.3"
// Six-Color) Bring-Up" checklist. Kept available (via the ee04-7in3-bringup
// PlatformIO environment) so the display driver can still be exercised in
// isolation if hardware issues resurface after the full app below lands.
//
// Deliberately does NOT include config_manager.h/ble_provisioning.h/
// ota_health.h/device_app.h - the ee04-7in3-bringup environment has no
// NimBLE/ArduinoJson lib_deps, since this mode never uses them.

SixColor73Display display;

void drawColorBars() {
    const uint8_t colors[] = {
        SixColor73::BLACK, SixColor73::WHITE, SixColor73::YELLOW,
        SixColor73::RED,   SixColor73::BLUE,  SixColor73::GREEN,
    };
    const uint16_t barWidth = DISPLAY_WIDTH / 6;

    for (int i = 0; i < 6; i++) {
        uint16_t xStart = i * barWidth;
        uint16_t xEnd = (i == 5) ? DISPLAY_WIDTH : xStart + barWidth;
        for (uint16_t x = xStart; x < xEnd; x++) {
            for (uint16_t y = 0; y < DISPLAY_HEIGHT; y++) {
                display.setPixel(x, y, colors[i]);
            }
        }
    }

    display.drawString(20, 20, "EE04 BRING-UP TEST", SixColor73::BLACK, 3);
}

void setup() {
    Serial.begin(115200);
    delay(2000);  // give USB serial time to attach before the first (only) refresh
    Serial.println("\n=== EE04 / ED2208 Display Bring-Up ===");

    if (!display.begin()) {
        Serial.println("Display init FAILED");
        return;
    }

    // First bring-up smoke tests, per firmware/README.md's checklist:
    //   1. display.clear(SixColor73::WHITE);
    //   2. display.clear(SixColor73::BLACK);
    //   3. drawColorBars();  <- once 1 and 2 both look right, move on to this
    drawColorBars();

    display.refresh();
    Serial.println("Refresh complete.");
    display.sleep();
}

void loop() {
    delay(1000);
}

#else  // !EE04_BRINGUP_TEST_MODE — full product firmware, same shape as ee02/main.cpp

#include "config_manager.h"
#include "ble_provisioning.h"
#include "ota_health.h"
#include "version.h"
#include "device_app.h"

SixColor73Display display;
ConfigManager configManager;
BLEProvisioning bleProvisioning(configManager);
OtaHealth otaHealth;

RTC_DATA_ATTR DeviceApp::RtcState rtcState;
DeviceApp::RunState runState;

/**
 * Renders a plain-text banner on the e-ink panel so a device sitting in config
 * mode is self-explanatory without a serial console attached. Board-specific
 * (not shared via device_app.h) because the layout is tuned to this panel's
 * much smaller resolution (vs. EE02's). Drawn with drawStringPortrait()
 * (portrait canvas: 480 wide x 800 tall - DISPLAY_HEIGHT x DISPLAY_WIDTH)
 * rather than drawString(), so it reads right-side up on a mounted device,
 * matching normal image content (which the Worker rotates the same way
 * before sending - see worker/src/lib/decode.ts's rotate90CW) instead of the
 * raw landscape buffer orientation.
 */
void showConfigModeScreen() {
    if (!display.begin()) {
        Serial.println("Config mode: display init failed - skipping screen render");
        return;
    }

    String mac = DeviceApp::getMACAddressClean();
    mac.toUpperCase();

    display.clear(SixColor73::WHITE);
    display.drawStringPortrait(20, 20, "E-INK SETUP MODE", SixColor73::BLACK, 3);
    display.drawStringPortrait(20, 100, "CONNECT VIA BLUETOOTH TO", SixColor73::BLACK, 2);
    display.drawStringPortrait(20, 130, "DEVICE NAME: EINK-SETUP", SixColor73::BLACK, 2);
    display.drawStringPortrait(20, 170, "THEN OPEN /PROVISION FROM", SixColor73::BLACK, 2);
    display.drawStringPortrait(20, 200, "CHROME OR EDGE (NOT SAFARI)", SixColor73::BLACK, 2);
    display.drawStringPortrait(20, 240, "MAC:", SixColor73::BLACK, 2);
    display.drawStringPortrait(20, 270, mac, SixColor73::BLACK, 3);
    display.refresh();
}

void runConfigMode() {
    Serial.println("\n========================================");
    Serial.println("CONFIGURATION MODE (Bluetooth)");
    Serial.println("========================================\n");
    configManager.printConfig();

    showConfigModeScreen();

    bleProvisioning.start();
    Serial.printf("Pair over Bluetooth (device name 'EInk-Setup') from %s/provision to configure WiFi/server settings\n",
                  DeviceApp::getBaseURL(configManager).c_str());

    // Runs until BLEProvisioning triggers a reboot (see handleCommand("save")).
    while (true) {
        bleProvisioning.loop();
        delay(10);
    }
}

void setup() {
    Serial.begin(115200);

    if (!DeviceApp::wasDeepSleepWakeup()) {
        delay(2000);
    }

    setCpuFrequencyMhz(ACTIVE_CPU_FREQ_MHZ);

    rtcState.bootCount++;
    bool firstBoot = (rtcState.bootCount == 1);

    // Full banner/version/boot-count only once per device lifetime - every
    // other wake reprints just what's relevant to whatever mode it ends up
    // in (see runConfigMode() and DeviceApp::runNormalMode()'s own headers).
    if (firstBoot) {
        Serial.println("\n========================================");
        Serial.println("Seeed EE04 E-Ink Display Firmware");
        Serial.printf("Version: %s\n", FIRMWARE_VERSION);
        Serial.println("========================================");
        Serial.printf("Boot count: %d\n", rtcState.bootCount);
    }
    DeviceApp::printWakeupReason(firstBoot);

    configManager.begin();
    configManager.ensureDeviceSecret();
    DeviceApp::ensureSharingKeyPair(configManager);

    otaHealth.begin();
    otaHealth.checkBootHealth();

    if (DeviceApp::checkConfigButton()) {
        runConfigMode();
        // runConfigMode never returns
    }

    if (configManager.getWifiSsid().length() == 0) {
        Serial.println("No WiFi credentials configured - entering config mode automatically");
        runConfigMode();
        // runConfigMode never returns
    }

    if (DeviceApp::runNormalMode(display, configManager, otaHealth, rtcState, runState) ==
        DeviceApp::NormalModeResult::NEEDS_PROVISIONING) {
        runConfigMode();
        // runConfigMode never returns
    }
}

void loop() {
    // This should never be reached due to deep sleep
    delay(1000);
}

#endif  // EE04_BRINGUP_TEST_MODE
