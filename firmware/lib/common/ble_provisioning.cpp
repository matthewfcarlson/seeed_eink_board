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

// Server-level connection diagnostics — logged to Serial so a real connection
// attempt (from the /provision page) can be told apart from the browser never
// reaching the device at all. Watch these during `pio device monitor`.
class ProvisioningServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override {
        Serial.printf("BLEProvisioning: Client connected (conn_handle=%d)\n", desc->conn_handle);
    }
    void onDisconnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override {
        Serial.printf("BLEProvisioning: Client disconnected (was encrypted=%d, bonded=%d)\n",
                      desc->sec_state.encrypted, desc->sec_state.bonded);
        // Resume advertising so a retry from the browser can reconnect without
        // needing another button-hold — NimBLE doesn't do this automatically.
        NimBLEDevice::getAdvertising()->start();
    }
    void onMTUChange(uint16_t mtu, ble_gap_conn_desc* desc) override {
        Serial.printf("BLEProvisioning: MTU negotiated: %d\n", mtu);
    }
    void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
        Serial.printf("BLEProvisioning: Authentication complete (encrypted=%d, authenticated=%d)\n",
                      desc->sec_state.encrypted, desc->sec_state.authenticated);
    }
};

static ProvisioningServerCallbacks* g_serverCallbacks = nullptr;

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
    // Bond records persist in NVS across reboots/reflashes. An earlier version of
    // this firmware required bonding (NIMBLE_PROPERTY::*_ENC); a stale bond from
    // that attempt can make a client (or its OS) keep trying to use encryption
    // this firmware no longer requests, surfacing as "GATT operation not
    // permitted" even though no characteristic here demands security anymore.
    // Config mode is rare and deliberate, so wiping bonds every time it starts
    // is a cheap way to guarantee a clean slate.
    NimBLEDevice::deleteAllBonds();

    // STA mode without connecting — required for on-demand WiFi scans (see
    // runWifiScanAndNotify()); coexists with BLE advertising on this chip.
    WiFi.mode(WIFI_STA);

    server_ = NimBLEDevice::createServer();
    g_serverCallbacks = new ProvisioningServerCallbacks();
    server_->setCallbacks(g_serverCallbacks);
    NimBLEService* service = server_->createService(BLE_SERVICE_UUID);

    infoChar_ = service->createCharacteristic(
        BLE_CHAR_INFO_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, 512);

    configWriteChar_ = service->createCharacteristic(
        BLE_CHAR_CONFIG_UUID, NIMBLE_PROPERTY::WRITE, 512);
    g_configCallbacks = new ProvisioningConfigCallbacks(this);
    configWriteChar_->setCallbacks(g_configCallbacks);

    commandChar_ = service->createCharacteristic(
        BLE_CHAR_COMMAND_UUID, NIMBLE_PROPERTY::WRITE, 32);
    g_commandCallbacks = new ProvisioningCommandCallbacks(this);
    commandChar_->setCallbacks(g_commandCallbacks);

    scanResultsChar_ = service->createCharacteristic(
        BLE_CHAR_SCAN_RESULTS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, 512);

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
    scanRequested_ = false;
    scanInProgress_ = false;

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
    delete g_serverCallbacks;
    g_configCallbacks = nullptr;
    g_commandCallbacks = nullptr;
    g_serverCallbacks = nullptr;
    Serial.println("BLEProvisioning: Stopped");
}

void BLEProvisioning::loop() {
    if (scanRequested_) {
        scanRequested_ = false;
        startWifiScan();
    }
    if (scanInProgress_) {
        pollWifiScan();
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
        scanRequested_ = true;
        refreshInfoCharacteristic("scanning");
    } else if (command == "reset") {
        config_.resetToDefaults();
        refreshInfoCharacteristic("idle");
    } else {
        Serial.printf("BLEProvisioning: Unknown command '%s'\n", command.c_str());
    }
}

void BLEProvisioning::startWifiScan() {
    Serial.println("BLEProvisioning: Scanning for WiFi networks...");
    // Async (non-blocking): WiFi.scanNetworks() without this blocks for several
    // seconds solid, which starves the RTOS task watchdog (and the BLE host task)
    // long enough to panic-reset the device — observed on hardware. Polled from
    // pollWifiScan() via WiFi.scanComplete() instead of blocking here.
    WiFi.scanNetworks(true);
    scanInProgress_ = true;
}

void BLEProvisioning::pollWifiScan() {
    int result = WiFi.scanComplete();
    if (result == WIFI_SCAN_RUNNING) return;

    scanInProgress_ = false;
    int count = (result == WIFI_SCAN_FAILED) ? 0 : result;

    // A single BLE notification can't span multiple ATT packets — unlike GATT
    // reads, there's no "long notify" reassembly — and a GATT attribute value is
    // hard-capped at 512 bytes regardless. 25+ nearby networks won't fit, so keep
    // only the strongest unique SSIDs and use short keys to stay well under that
    // cap (see BLE_CHAR_SCAN_RESULTS_UUID's max_len in start()).
    const int MAX_NETWORKS = 8;
    int order[MAX_NETWORKS];
    int orderedCount = 0;

    for (int i = 0; i < count; i++) {
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0) continue;

        bool isDuplicate = false;
        for (int j = 0; j < orderedCount; j++) {
            if (WiFi.SSID(order[j]) == ssid) {
                isDuplicate = true;
                if (WiFi.RSSI(i) > WiFi.RSSI(order[j])) order[j] = i;  // keep the stronger AP
                break;
            }
        }
        if (isDuplicate) continue;

        if (orderedCount < MAX_NETWORKS) {
            order[orderedCount++] = i;
        } else {
            // Replace the weakest kept entry if this one is stronger.
            int weakestIdx = 0;
            for (int j = 1; j < orderedCount; j++) {
                if (WiFi.RSSI(order[j]) < WiFi.RSSI(order[weakestIdx])) weakestIdx = j;
            }
            if (WiFi.RSSI(i) > WiFi.RSSI(order[weakestIdx])) order[weakestIdx] = i;
        }
    }

    // Sort kept entries strongest-first (simple insertion sort — at most 8 items).
    for (int i = 1; i < orderedCount; i++) {
        int key = order[i];
        int j = i - 1;
        while (j >= 0 && WiFi.RSSI(order[j]) < WiFi.RSSI(key)) {
            order[j + 1] = order[j];
            j--;
        }
        order[j + 1] = key;
    }

    JsonDocument doc;
    JsonArray networks = doc.to<JsonArray>();
    for (int i = 0; i < orderedCount; i++) {
        JsonObject net = networks.add<JsonObject>();
        net["s"] = WiFi.SSID(order[i]);
        net["r"] = WiFi.RSSI(order[i]);
        net["o"] = WiFi.encryptionType(order[i]) == WIFI_AUTH_OPEN;  // "open" (unsecured)
    }
    WiFi.scanDelete();

    String json;
    serializeJson(doc, json);
    scanResultsChar_->setValue(json);
    scanResultsChar_->notify();

    Serial.printf("BLEProvisioning: Found %d networks (kept %d unique, strongest first)\n", count, orderedCount);
    refreshInfoCharacteristic("idle");
}
