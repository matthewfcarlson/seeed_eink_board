#pragma once
#include "Arduino.h"

#include <mach-o/dyld.h>
#include <mach-o/loader.h>

#ifndef SIM_DEVICE_MAC_HEX
#define SIM_DEVICE_MAC_HEX "020000000000"  // last-resort fallback - see buildUuid() below
#endif

namespace SimMac {

// Reads this running binary's linker-assigned LC_UUID (visible in `otool -l`,
// the same identifier dSYMs are matched against) straight out of its own
// loaded Mach-O header - no need to open/hash the file on disk ourselves.
// _dyld_get_image_header(0) is always the main executable, never a dylib
// (those start at index 1) - see dyld's own docs for that ordering guarantee.
// A rebuild - even of unchanged source - gets a new linker-assigned UUID, and
// that's the whole point: this simulated device's identity (both its MAC,
// below, and main_native.cpp's "does persisted state still belong to this
// binary?" check) is meant to change on every rebuild, standing in for
// swapping in a distinct physical unit rather than reflashing the same one.
inline bool readMachoUuid(uint8_t uuid[16]) {
    const struct mach_header *header = _dyld_get_image_header(0);
    if (!header) return false;

    const uint8_t *cursor;
    uint32_t ncmds;
    if (header->magic == MH_MAGIC_64) {
        auto *header64 = (const struct mach_header_64 *)header;
        cursor = (const uint8_t *)header64 + sizeof(struct mach_header_64);
        ncmds = header64->ncmds;
    } else if (header->magic == MH_MAGIC) {
        cursor = (const uint8_t *)header + sizeof(struct mach_header);
        ncmds = header->ncmds;
    } else {
        return false;  // unexpected - not a Mach-O we know how to walk
    }

    for (uint32_t i = 0; i < ncmds; i++) {
        auto *lc = (const struct load_command *)cursor;
        if (lc->cmd == LC_UUID) {
            memcpy(uuid, ((const struct uuid_command *)lc)->uuid, 16);
            return true;
        }
        cursor += lc->cmdsize;
    }
    return false;
}

// This process's build identity as a 32-char lowercase hex string - the full
// 16-byte LC_UUID, not just the 5 bytes buildMacAddress() below keeps. Used
// only for the "did the binary change since last run" comparison in
// main_native.cpp; kept at full width there so that check doesn't inherit
// the MAC's own (already-astronomically-unlikely) truncation collisions.
inline std::string buildIdentityHex() {
    uint8_t uuid[16];
    if (!readMachoUuid(uuid)) return std::string(SIM_DEVICE_MAC_HEX);  // stable fallback, still comparable
    char hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + i * 2, 3, "%02x", uuid[i]);
    return std::string(hex, 32);
}

// This simulated device's MAC - locally-administered (0x02 high nibble,
// matching the existing "02:00:..." convention), derived from this same
// build's Mach-O UUID. Recomputed fresh every process start (cheap, and
// there's no reason to cache it to disk): it's meant to change whenever the
// binary is rebuilt, which is also when main_native.cpp wipes this board's
// persisted NVS state - see its wipeStateIfBuildChanged().
inline void buildMacAddress(uint8_t mac[6]) {
    static bool cached = false;
    static uint8_t cachedMac[6];
    if (cached) {
        memcpy(mac, cachedMac, 6);
        return;
    }

    uint8_t uuid[16];
    if (readMachoUuid(uuid)) {
        cachedMac[0] = 0x02;
        memcpy(cachedMac + 1, uuid, 5);
    } else {
        // Mach-O introspection failed (shouldn't happen on macOS) - fall back
        // to the Makefile's fixed per-board default rather than leaving this
        // uninitialized.
        const char *hexFallback = SIM_DEVICE_MAC_HEX;
        for (int i = 0; i < 6; i++) {
            char byteStr[3] = {hexFallback[i * 2], hexFallback[i * 2 + 1], 0};
            cachedMac[i] = (uint8_t)strtoul(byteStr, nullptr, 16);
        }
    }

    cached = true;
    memcpy(mac, cachedMac, 6);
}

}  // namespace SimMac

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

    void macAddress(uint8_t *mac) { SimMac::buildMacAddress(mac); }

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
