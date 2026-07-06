#ifndef BLE_PROVISIONING_H
#define BLE_PROVISIONING_H

#include <Arduino.h>
#include <NimBLEDevice.h>
#include "config_manager.h"

// Advertised name the browser's device picker shows — matches the old AP-mode SSID
// so instructions/screenshots referencing "EInk-Setup" still make sense.
#define BLE_DEVICE_NAME "EInk-Setup"

// Randomly generated, not registered with the Bluetooth SIG — fine for a custom
// (non-standard) GATT profile like this one. Must match worker/src/provision-ui.ts.
#define BLE_SERVICE_UUID           "00dc0948-cda5-4429-b7f3-5ea67f1b1347"
#define BLE_CHAR_INFO_UUID         "7a209705-d097-43bb-a724-a41d29504486"
#define BLE_CHAR_CONFIG_UUID       "514a006a-319b-4e01-ba80-aa38bf8e5b1f"
#define BLE_CHAR_COMMAND_UUID      "1bc65320-3316-4de8-8a2c-89c89fa792ff"
#define BLE_CHAR_SCAN_RESULTS_UUID "97c497fa-7e94-4fe6-bad2-68ffd9d34d5e"

/**
 * Bluetooth LE GATT config portal — replaces the old AP-mode/STA-mode HTTP
 * captive portal (config_server.h/.cpp, removed). A browser pairs directly over
 * BLE from the /provision page (Web Bluetooth); no need to join a temporary WiFi
 * network or know the device's IP first.
 *
 * GATT schema (service BLE_SERVICE_UUID), all values UTF-8 JSON unless noted:
 *   INFO          (read, notify)  — device_mac, firmware_version, wifi_ssid
 *                                   (password never read back), wifi_configured,
 *                                   server settings, and `state` (idle/scanning/saving).
 *   CONFIG_WRITE  (write)         — partial JSON of any settable field: wifi_ssid,
 *                                   wifi_password, host, port, use_https, endpoint,
 *                                   sleep_minutes, active_start_hour, active_end_hour,
 *                                   timezone_offset_minutes. Buffered in RAM only —
 *                                   nothing touches NVS until COMMAND "save".
 *   COMMAND       (write)         — plain string: "save" (persist buffered config,
 *                                   then reboot), "scan" (trigger an async WiFi scan;
 *                                   results arrive via SCAN_RESULTS), or "reset"
 *                                   (defaults). Scanning is async (WiFi.scanNetworks(true),
 *                                   polled from loop()) — a blocking scan starves the
 *                                   RTOS watchdog long enough to panic-reset the device.
 *   SCAN_RESULTS  (read, notify)  — JSON array of {s: ssid, r: rssi, o: open} for the
 *                                   strongest ~8 unique networks (short keys, capped
 *                                   count — a GATT attribute value is hard-capped at
 *                                   512 bytes, and a notification can't span multiple
 *                                   ATT packets the way a long read can, so an
 *                                   unfiltered scan of 20+ nearby networks won't fit).
 *
 * Characteristics are plain READ/WRITE, not encryption-required. An earlier version
 * used NIMBLE_PROPERTY::*_ENC to force BLE bonding before any value (notably the
 * WiFi password) crossed the air, but Web Bluetooth has no API to initiate that
 * pairing itself — a browser GATT read/write against an encrypted characteristic
 * with no existing bond just fails outright ("GATT operation not permitted"),
 * making the feature unusable from a browser rather than making it secure. So the
 * WiFi password does cross the air in the clear during the brief provisioning
 * window; the mitigating factor is that config mode only runs for as long as it
 * takes to provision (button-hold triggered, or first boot), not indefinitely.
 */
class BLEProvisioning {
public:
    explicit BLEProvisioning(ConfigManager& configManager);

    void start();
    void stop();
    // Call every loop iteration from runConfigMode() — handles deferred reboot
    // (so a reboot never cuts off an in-flight BLE response) and scan results.
    void loop();

private:
    ConfigManager& config_;
    NimBLEServer* server_ = nullptr;
    NimBLECharacteristic* infoChar_ = nullptr;
    NimBLECharacteristic* configWriteChar_ = nullptr;
    NimBLECharacteristic* commandChar_ = nullptr;
    NimBLECharacteristic* scanResultsChar_ = nullptr;

    // Buffered edits from CONFIG_WRITE, applied to config_ only on COMMAND "save".
    String pendingWifiSsid_;
    String pendingWifiPassword_;
    String pendingHost_;
    uint16_t pendingPort_ = 0;
    bool pendingUseHttps_ = false;
    bool pendingUseHttpsSet_ = false;
    String pendingEndpoint_;
    uint16_t pendingSleepMinutes_ = 0;
    int pendingActiveStartHour_ = -1;
    int pendingActiveEndHour_ = -1;
    int pendingTimezoneOffsetMinutes_ = 9999;

    bool rebootPending_ = false;
    uint32_t rebootAtMs_ = 0;

    // WiFi scans run asynchronously (WiFi.scanNetworks(true)) and are polled from
    // loop() via WiFi.scanComplete() — a blocking scan can starve the RTOS task
    // watchdog long enough to panic-reset the device (observed on hardware).
    bool scanRequested_ = false;
    bool scanInProgress_ = false;

    void refreshInfoCharacteristic(const char* state);
    void handleConfigWrite(const String& json);
    void handleCommand(const String& command);
    void startWifiScan();
    void pollWifiScan();

    friend class ProvisioningConfigCallbacks;
    friend class ProvisioningCommandCallbacks;
};

#endif // BLE_PROVISIONING_H
