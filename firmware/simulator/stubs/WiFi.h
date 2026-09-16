#pragma once
#include "Arduino.h"

#ifndef SIM_DEVICE_MAC_HEX
#define SIM_DEVICE_MAC_HEX "020000000000"  // overridden per board by the Makefile
#endif

#define WL_CONNECTED    3
#define WL_DISCONNECTED 6
#define WIFI_STA        1
#define WIFI_OFF        0

#define WIFI_SCAN_RUNNING -1
#define WIFI_SCAN_FAILED  -2
#define WIFI_AUTH_OPEN     0

typedef int wifi_power_t;
#define WIFI_POWER_19_5dBm 78
#define WIFI_POWER_11dBm   44

struct SimFakeNetwork {
    const char *ssid;
    int32_t rssi;
    int authMode;  // WIFI_AUTH_OPEN, or nonzero for "secured"
};

// No real radio in the simulator - a fixed, plausible-looking network list
// stands in for a real scan (see startWifiScan()/pollWifiScan() in
// ble_provisioning.cpp, which this feeds via scanComplete()/SSID()/RSSI()/
// encryptionType()).
static const SimFakeNetwork SIM_FAKE_NETWORKS[] = {
    {"Simulated-Home-WiFi", -42, 3},
    {"Neighbor-5G", -67, 3},
    {"Coffee Shop Guest", -55, WIFI_AUTH_OPEN},
};
static const int SIM_FAKE_NETWORK_COUNT = 3;

struct WiFiClass {
    void mode(int)                  {}
    void begin(const char *, const char *) {}
    void begin(const char *, const char *, int32_t, const uint8_t *) {}
    void setTxPower(wifi_power_t)   {}
    int  status()                   { return WL_CONNECTED; }
    IPAddress localIP()             { IPAddress ip; ip.bytes[0] = 127; ip.bytes[3] = 1; return ip; }
    void disconnect(bool = false)   {}
    int32_t channel()                { return 1; }
    uint8_t *BSSID()                 { static uint8_t bssid[6] = {0, 0, 0, 0, 0, 0}; return bssid; }

    void macAddress(uint8_t *mac) {
        const char *hex = SIM_DEVICE_MAC_HEX;
        for (int i = 0; i < 6; i++) {
            char byteStr[3] = {hex[i * 2], hex[i * 2 + 1], 0};
            mac[i] = (uint8_t)strtoul(byteStr, nullptr, 16);
        }
    }

    // --- Fake async scan, mirroring the real WiFi.scanNetworks(true) /
    // scanComplete() polling shape ble_provisioning.cpp uses. ---
    void scanNetworks(bool /*async*/) { scanStartMs_ = millis(); scanRunning_ = true; }
    int scanComplete() {
        if (!scanRunning_) return WIFI_SCAN_FAILED;
        if (millis() - scanStartMs_ < 400) return WIFI_SCAN_RUNNING;
        return SIM_FAKE_NETWORK_COUNT;
    }
    String SSID(int i)            { return String(SIM_FAKE_NETWORKS[i].ssid); }
    int32_t RSSI(int i)           { return SIM_FAKE_NETWORKS[i].rssi; }
    int encryptionType(int i)     { return SIM_FAKE_NETWORKS[i].authMode; }
    void scanDelete()             { scanRunning_ = false; }

private:
    uint32_t scanStartMs_ = 0;
    bool scanRunning_ = false;
};
inline WiFiClass WiFi;
