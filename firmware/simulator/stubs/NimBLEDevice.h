#pragma once
#include <cstdint>
#include <string>
#include "Arduino.h"
#include "../gatt_bridge.h"

// Stubs the exact NimBLE-Arduino surface firmware/lib/common/ble_provisioning.cpp
// uses, routing it through gatt_bridge.h's HTTP+SSE server instead of a real
// BLE radio - there's no virtual BLE peripheral API on macOS, so this is the
// only way to exercise the real ble_provisioning.cpp against the real
// /provision page's `?sim=` transport. See gatt_bridge.h's header comment for
// the full rationale.
//
// These four UUIDs are duplicated from firmware/lib/common/ble_provisioning.h
// (not shared via #include - that header itself #includes <NimBLEDevice.h>,
// so including it here would be circular) and MUST be kept identical to its
// BLE_CHAR_*_UUID constants.
namespace SimBleUuid {
constexpr const char *INFO = "7a209705-d097-43bb-a724-a41d29504486";
constexpr const char *CONFIG_WRITE = "514a006a-319b-4e01-ba80-aa38bf8e5b1f";
constexpr const char *COMMAND = "1bc65320-3316-4de8-8a2c-89c89fa792ff";
constexpr const char *SCAN_RESULTS = "97c497fa-7e94-4fe6-bad2-68ffd9d34d5e";
}  // namespace SimBleUuid

// The port the /provision page's `?sim=` transport talks to - fixed rather
// than configurable, matching the value used throughout this project's docs.
#ifndef SIM_GATT_PORT
#define SIM_GATT_PORT 8790
#endif

namespace NIMBLE_PROPERTY {
constexpr uint32_t READ = 1;
constexpr uint32_t WRITE = 2;
constexpr uint32_t NOTIFY = 4;
}  // namespace NIMBLE_PROPERTY

struct ble_gap_sec_state {
    int encrypted = 0;
    int bonded = 0;
    int authenticated = 0;
};
struct ble_gap_conn_desc {
    uint16_t conn_handle = 0;
    ble_gap_sec_state sec_state;
};

class NimBLECharacteristic;

class NimBLECharacteristicCallbacks {
public:
    virtual ~NimBLECharacteristicCallbacks() {}
    virtual void onWrite(NimBLECharacteristic *) {}
};

class NimBLEServer;

class NimBLEServerCallbacks {
public:
    virtual ~NimBLEServerCallbacks() {}
    // Never actually invoked by this stub: each /provision request is a
    // short-lived HTTP call, not a persistent "connection" the way a real
    // BLE central/peripheral pairing is - there's no equivalent moment to
    // fire these from. Kept only so ble_provisioning.cpp's
    // ProvisioningServerCallbacks subclass still compiles unmodified.
    virtual void onConnect(NimBLEServer *, ble_gap_conn_desc *) {}
    virtual void onDisconnect(NimBLEServer *, ble_gap_conn_desc *) {}
    virtual void onMTUChange(uint16_t, ble_gap_conn_desc *) {}
    virtual void onAuthenticationComplete(ble_gap_conn_desc *) {}
};

class NimBLECharacteristic {
public:
    explicit NimBLECharacteristic(std::string uuid) : uuid_(std::move(uuid)) {}

    void setValue(const std::string &v) {
        value_ = v;
        if (uuid_ == SimBleUuid::INFO) GattBridge::setInfoValue(v);
        else if (uuid_ == SimBleUuid::SCAN_RESULTS) GattBridge::setScanResultsValue(v);
    }
    void setValue(const String &v) { setValue(std::string(v.c_str())); }

    void notify() {
        if (uuid_ == SimBleUuid::INFO) GattBridge::notifyInfo();
        else if (uuid_ == SimBleUuid::SCAN_RESULTS) GattBridge::notifyScanResults();
    }

    // Real NimBLEAttValue also exposes c_str(); std::string already does.
    std::string getValue() const { return value_; }

    void setCallbacks(NimBLECharacteristicCallbacks *callbacks) {
        callbacks_ = callbacks;
        if (uuid_ == SimBleUuid::CONFIG_WRITE) {
            GattBridge::setConfigWriteHandler([this](const std::string &json) {
                value_ = json;
                if (callbacks_) callbacks_->onWrite(this);
            });
        } else if (uuid_ == SimBleUuid::COMMAND) {
            GattBridge::setCommandHandler([this](const std::string &command) {
                value_ = command;
                if (callbacks_) callbacks_->onWrite(this);
            });
        }
    }

private:
    std::string uuid_;
    std::string value_;
    NimBLECharacteristicCallbacks *callbacks_ = nullptr;
};

class NimBLEService {
public:
    NimBLECharacteristic *createCharacteristic(const char *uuid, uint32_t /*properties*/, uint16_t /*maxLen*/) {
        return new NimBLECharacteristic(uuid);
    }
    void start() {}
};

class NimBLEServer {
public:
    NimBLEService *createService(const char * /*uuid*/) { return new NimBLEService(); }
    // Stored but never invoked - see NimBLEServerCallbacks's comment above.
    void setCallbacks(NimBLEServerCallbacks *callbacks) { callbacks_ = callbacks; }

private:
    NimBLEServerCallbacks *callbacks_ = nullptr;
};

class NimBLEAdvertising {
public:
    void addServiceUUID(const char *) {}
    void setScanResponse(bool) {}
    void start() {}
    void stop() {}
};

class NimBLEDevice {
public:
    static void init(const char * /*deviceName*/) { GattBridge::start(SIM_GATT_PORT); }
    static void setMTU(uint16_t) {}
    static void deleteAllBonds() {}
    static NimBLEServer *createServer() { return new NimBLEServer(); }
    static NimBLEAdvertising *getAdvertising() {
        static NimBLEAdvertising advertising;
        return &advertising;
    }
    static void deinit(bool /*clearAll*/) { GattBridge::stop(); }
};
