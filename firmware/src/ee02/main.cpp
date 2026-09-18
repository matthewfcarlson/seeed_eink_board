#include <Arduino.h>
#include "config.h"
#include "display.h"
#include "config_manager.h"
#include "ble_provisioning.h"
#include "ota_health.h"
#include "version.h"
#include "device_app.h"

// Global instances
Spectra6Display display;
ConfigManager configManager;
BLEProvisioning bleProvisioning(configManager);
OtaHealth otaHealth;

// See DeviceApp::RtcState's comment: plain aggregate, zero-initialized by
// static-storage semantics on first power-on only, unaffected by deep sleep.
RTC_DATA_ATTR DeviceApp::RtcState rtcState;
DeviceApp::RunState runState;

/**
 * Renders a plain-text banner on the e-ink panel so a device sitting in config
 * mode is self-explanatory without a serial console attached. Board-specific
 * (not shared via device_app.h) because the layout is tuned to this panel's
 * resolution. Drawn with drawStringPortrait() (portrait canvas: 1200 wide x
 * 1600 tall - DISPLAY_HEIGHT x DISPLAY_WIDTH) rather than drawString(), so it
 * reads right-side up on a mounted device, matching normal image content
 * (which the Worker rotates the same way before sending - see
 * worker/src/lib/decode.ts's rotate90CW) instead of the raw landscape buffer
 * orientation.
 */
void showConfigModeScreen() {
    if (!display.begin()) {
        Serial.println("Config mode: display init failed - skipping screen render");
        return;
    }

    String mac = DeviceApp::getMACAddressClean();
    mac.toUpperCase();

    display.clear(Spectra6Color::WHITE);
    display.drawStringPortrait(40, 40, "E-INK SETUP MODE", Spectra6Color::BLACK, 6);
    display.drawStringPortrait(40, 200, "CONNECT VIA BLUETOOTH TO", Spectra6Color::BLACK, 4);
    display.drawStringPortrait(40, 260, "DEVICE NAME: EINK-SETUP", Spectra6Color::BLACK, 4);
    display.drawStringPortrait(40, 340, "THEN OPEN /PROVISION FROM", Spectra6Color::BLACK, 4);
    display.drawStringPortrait(40, 400, "CHROME OR EDGE (NOT SAFARI)", Spectra6Color::BLACK, 4);
    display.drawStringPortrait(40, 480, "MAC:", Spectra6Color::BLACK, 4);
    display.drawStringPortrait(40, 540, mac, Spectra6Color::BLACK, 5);
    display.refresh();
}

void runConfigMode() {
    Serial.println("\n========================================");
    Serial.println("CONFIGURATION MODE (Bluetooth)");
    Serial.println("========================================\n");

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

    Serial.println("\n========================================");
    Serial.println("Seeed EE02 E-Ink Display Firmware");
    Serial.printf("Version: %s\n", FIRMWARE_VERSION);
    Serial.println("========================================");

    rtcState.bootCount++;
    Serial.printf("Boot count: %d\n", rtcState.bootCount);
    DeviceApp::printWakeupReason();

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
