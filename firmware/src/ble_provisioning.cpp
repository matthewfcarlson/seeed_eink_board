#include "ble_provisioning.h"
#include <ArduinoJson.h>
#include <WiFi.h>
#include "version.h"

static String getMACClean() {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char macStr[13];
    snprintf(macStr, sizeof(macStr), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return String(macStr);
}

class ProvisioningConfigCallbacks : public NimBLECharacteristicCallbacks {
public:
    explicit ProvisioningConfigCallbacks(BLEProvisioning* owner) : owner_(owner) {}
    void onWrite(NimBLECharacteristic* pCharacteristic) override {
        owner_->handleConfigWrite(String(pCharacteristic->getValue().c_str()));
    }
private:
    BLEProvisioning* owner_;
};

class ProvisioningCommandCallbacks : public NimBLECharacteristicCallbacks {
public:
    explicit ProvisioningCommandCallbacks(BLEProvisioning* owner) : owner_(owner) {}
    void onWrite(NimBLECharacteristic* pCharacteristic) override {
        owner_->handleCommand(String(pCharacteristic->getValue().c_str()));
    }
private:
    BLEProvisioning* owner_;
};

// Owned for the lifetime of one config-mode session; recreated each start().
static ProvisioningConfigCallbacks* g_configCallbacks = nullptr;
static ProvisioningCommandCallbacks* g_commandCallbacks = nullptr;

BLEProvisioning::BLEProvisioning(ConfigManager& configManager) : config_(configManager) {
}

void BLEProvisioning::start() {
    Serial.println("BLEProvisioning: Starting BLE advertising...");

    NimBLEDevice::init(BLE_DEVICE_NAME);
    NimBLEDevice::setMTU(517);
    // Bonding + secure connections, no MITM (Web Bluetooth has no passkey-entry UI
    // to defend against MITM with anyway) — Just Works pairing, encrypting the link
    // before any characteristic value crosses the air.
    NimBLEDevice::setSecurityAuth(true, false, true);
    NimBLEDevice::setSecurityIOCap(ESP_IO_CAP_NONE);

    // STA mode without connecting — required for on-demand WiFi scans (see
    // runWifiScanAndNotify()); coexists with BLE advertising on this chip.
    WiFi.mode(WIFI_STA);

    server_ = NimBLEDevice::createServer();
    NimBLEService* service = server_->createService(BLE_SERVICE_UUID);

    infoChar_ = service->createCharacteristic(
        BLE_CHAR_INFO_UUID, NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY, 512);

    configWriteChar_ = service->createCharacteristic(
        BLE_CHAR_CONFIG_UUID, NIMBLE_PROPERTY::WRITE_ENC, 512);
    g_configCallbacks = new ProvisioningConfigCallbacks(this);
    configWriteChar_->setCallbacks(g_configCallbacks);

    commandChar_ = service->createCharacteristic(
        BLE_CHAR_COMMAND_UUID, NIMBLE_PROPERTY::WRITE_ENC, 32);
    g_commandCallbacks = new ProvisioningCommandCallbacks(this);
    commandChar_->setCallbacks(g_commandCallbacks);

    scanResultsChar_ = service->createCharacteristic(
        BLE_CHAR_SCAN_RESULTS_UUID, NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY, 512);

    service->start();

    // Reset buffered-edit sentinels each time provisioning starts fresh.
    pendingWifiSsid_ = "";
    pendingWifiPassword_ = "";
    pendingHost_ = "";
    pendingPort_ = 0;
    pendingUseHttps_ = false;
    pendingUseHttpsSet_ = false;
    pendingEndpoint_ = "";
    pendingSleepMinutes_ = 0;
    pendingActiveStartHour_ = -1;
    pendingActiveEndHour_ = -1;
    pendingTimezoneOffsetMinutes_ = 9999;
    rebootPending_ = false;
    scanPending_ = false;

    refreshInfoCharacteristic("idle");

    NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
    advertising->addServiceUUID(BLE_SERVICE_UUID);
    advertising->setScanResponse(true);
    advertising->start();

    Serial.println("BLEProvisioning: Advertising as '" BLE_DEVICE_NAME "'");
}

void BLEProvisioning::stop() {
    NimBLEDevice::getAdvertising()->stop();
    NimBLEDevice::deinit(true);
    server_ = nullptr;
    infoChar_ = nullptr;
    configWriteChar_ = nullptr;
    commandChar_ = nullptr;
    scanResultsChar_ = nullptr;
    delete g_configCallbacks;
    delete g_commandCallbacks;
    g_configCallbacks = nullptr;
    g_commandCallbacks = nullptr;
    Serial.println("BLEProvisioning: Stopped");
}

void BLEProvisioning::loop() {
    if (scanPending_) {
        scanPending_ = false;
        runWifiScanAndNotify();
    }
    if (rebootPending_ && millis() >= rebootAtMs_) {
        Serial.println("BLEProvisioning: Rebooting into normal mode...");
        ESP.restart();
    }
}

void BLEProvisioning::refreshInfoCharacteristic(const char* state) {
    JsonDocument doc;
    doc["device_mac"] = getMACClean();
    doc["firmware_version"] = FIRMWARE_VERSION;
    doc["wifi_ssid"] = config_.getWifiSsid();
    doc["wifi_configured"] = config_.getWifiSsid().length() > 0;
    doc["host"] = config_.getServerHost();
    doc["port"] = config_.getServerPort();
    doc["use_https"] = config_.getUseHttps();
    doc["endpoint"] = config_.getImageEndpoint();
    doc["sleep_minutes"] = config_.getSleepMinutes();
    doc["active_start_hour"] = config_.getActiveStartHour();
    doc["active_end_hour"] = config_.getActiveEndHour();
    doc["timezone_offset_minutes"] = config_.getTimezoneOffsetMinutes();
    doc["state"] = state;

    String json;
    serializeJson(doc, json);
    infoChar_->setValue(json);
    infoChar_->notify();
}

void BLEProvisioning::handleConfigWrite(const String& json) {
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, json);
    if (error) {
        Serial.printf("BLEProvisioning: Failed to parse CONFIG_WRITE JSON: %s\n", error.c_str());
        return;
    }

    if (doc["wifi_ssid"].is<const char*>()) pendingWifiSsid_ = doc["wifi_ssid"].as<String>();
    if (doc["wifi_password"].is<const char*>()) pendingWifiPassword_ = doc["wifi_password"].as<String>();
    if (doc["host"].is<const char*>()) pendingHost_ = doc["host"].as<String>();
    if (doc["port"].is<int>()) pendingPort_ = doc["port"].as<uint16_t>();
    if (doc["use_https"].is<bool>()) {
        pendingUseHttps_ = doc["use_https"].as<bool>();
        pendingUseHttpsSet_ = true;
    }
    if (doc["endpoint"].is<const char*>()) pendingEndpoint_ = doc["endpoint"].as<String>();
    if (doc["sleep_minutes"].is<int>()) pendingSleepMinutes_ = doc["sleep_minutes"].as<uint16_t>();
    if (doc["active_start_hour"].is<int>()) pendingActiveStartHour_ = doc["active_start_hour"].as<int>();
    if (doc["active_end_hour"].is<int>()) pendingActiveEndHour_ = doc["active_end_hour"].as<int>();
    if (doc["timezone_offset_minutes"].is<int>()) {
        pendingTimezoneOffsetMinutes_ = doc["timezone_offset_minutes"].as<int>();
    }

    Serial.println("BLEProvisioning: Buffered config update");
    refreshInfoCharacteristic("editing");
}

void BLEProvisioning::handleCommand(const String& command) {
    if (command == "save") {
        refreshInfoCharacteristic("saving");

        if (pendingWifiSsid_.length() > 0) {
            config_.setWifiCredentials(pendingWifiSsid_, pendingWifiPassword_);
        }

        // setConfig() only overwrites fields it considers "set" (non-empty strings,
        // in-range numbers) — the sentinels for untouched fields (0, -1, 9999) all
        // fall outside the ranges it validates, so they safely no-op there rather
        // than clobbering values the user didn't touch this session.
        config_.setConfig(
            pendingHost_,
            pendingPort_,
            pendingUseHttpsSet_ ? pendingUseHttps_ : config_.getUseHttps(),
            pendingEndpoint_,
            pendingSleepMinutes_,
            pendingActiveStartHour_ >= 0 ? pendingActiveStartHour_ : config_.getActiveStartHour(),
            pendingActiveEndHour_ >= 0 ? pendingActiveEndHour_ : config_.getActiveEndHour(),
            pendingTimezoneOffsetMinutes_ != 9999 ? pendingTimezoneOffsetMinutes_
                                                   : config_.getTimezoneOffsetMinutes());

        Serial.println("BLEProvisioning: Configuration saved - rebooting shortly");
        refreshInfoCharacteristic("saved_rebooting");
        rebootPending_ = true;
        rebootAtMs_ = millis() + 400;  // let the notify flush before the connection drops
    } else if (command == "scan") {
        scanPending_ = true;
        refreshInfoCharacteristic("scanning");
    } else if (command == "reset") {
        config_.resetToDefaults();
        refreshInfoCharacteristic("idle");
    } else {
        Serial.printf("BLEProvisioning: Unknown command '%s'\n", command.c_str());
    }
}

void BLEProvisioning::runWifiScanAndNotify() {
    Serial.println("BLEProvisioning: Scanning for WiFi networks...");
    int count = WiFi.scanNetworks();

    JsonDocument doc;
    JsonArray networks = doc.to<JsonArray>();
    for (int i = 0; i < count; i++) {
        JsonObject net = networks.add<JsonObject>();
        net["ssid"] = WiFi.SSID(i);
        net["rssi"] = WiFi.RSSI(i);
        net["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    }
    WiFi.scanDelete();

    String json;
    serializeJson(doc, json);
    scanResultsChar_->setValue(json);
    scanResultsChar_->notify();

    Serial.printf("BLEProvisioning: Found %d networks\n", count);
    refreshInfoCharacteristic("idle");
}
