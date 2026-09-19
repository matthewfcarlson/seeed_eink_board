#pragma once
#include <map>
#include <string>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <sys/stat.h>
#include "Arduino.h"

#ifndef SIM_STATE_DIR
#define SIM_STATE_DIR "default"
#endif

// The directory name actually used on disk (".state/<this>/<namespace>.txt")
// - set once by main_native.cpp's boardStateDir(), before any Preferences
// use, to SIM_STATE_DIR plus a suffix unique to this build (its own Mach-O
// UUID - see stubs/WiFi.h's SimMac::buildIdentityHex()). That's what keeps
// two instances of the same board from ever sharing a directory: every
// `make run-<board>` relinks first, and a relink gets a new UUID even for
// unchanged source, so a rebuild naturally lands on a brand new, empty
// directory instead of reusing (and colliding with, if an earlier instance
// is still running) the previous one. Defaults to the bare per-board literal
// so anything that (implausibly) touches Preferences before main() sets this
// still lands somewhere sane rather than an empty path.
inline std::string g_simStateDir = SIM_STATE_DIR;

// Real ESP32 NVS survives both deep sleep AND a full power cycle. Unlike
// epaper_clock's Preferences stub (memory-only - fine there, since its one
// pre-seeded config line costs nothing to redo), ours needs the same
// durability: WiFi credentials, the per-device HMAC secret, and registration
// status are expensive to redo (a fresh secret means re-registering with the
// Worker) if you had to reprovision on every single `./sim-<board>` run. So
// each namespace ("eink_config", "ota_health" - see config_manager.cpp /
// ota_health.cpp) is backed by a small text file under
// .state/<g_simStateDir>/<namespace>.txt. Not real JSON -
// just "key\tvalue" lines - this is internal-only state, not a wire format.
// config_manager.cpp's ConfigManager holds one Preferences instance for its
// whole lifetime, reused across begin()/end() pairs. In the simulator that
// instance can be touched both from the main thread (normal-mode config
// reads) and from gatt_bridge's connection threads (a provisioning save) -
// unlike real single-core-at-a-time Arduino code, so every public method
// here takes a mutex.
class Preferences {
public:
    // Matches the real ESP32 Preferences::begin() signature (bool return:
    // false when opening read-only and the namespace doesn't exist yet -
    // e.g. fresh .state dir - so firmware's loadFromNVS() early-return path
    // is exercised the same way it is on hardware).
    bool begin(const char *ns, bool readOnly = false) {
        std::lock_guard<std::mutex> lock(mutex_);
        ns_ = ns ? ns : "";
        readOnly_ = readOnly;
        load();
        if (readOnly) {
            FILE *f = fopen(filePath().c_str(), "r");
            if (!f) return false;
            fclose(f);
        }
        return true;
    }
    void end() {}  // every mutator below saves immediately - see putRaw()/remove()

    bool putString(const char *key, const String &v) { return putRaw(key, v.c_str()); }
    bool putString(const char *key, const char *v)   { return putRaw(key, v ? v : ""); }
    String getString(const char *key, const char *def = "") const { return String(getRaw(key, def).c_str()); }

    bool putBool(const char *key, bool v) { return putRaw(key, v ? "1" : "0"); }
    bool getBool(const char *key, bool def) const { return getRaw(key, def ? "1" : "0") == "1"; }

    bool putUInt(const char *key, uint32_t v) { return putRaw(key, std::to_string(v)); }
    uint32_t getUInt(const char *key, uint32_t def = 0) const {
        return (uint32_t)strtoul(getRaw(key, std::to_string(def)).c_str(), nullptr, 10);
    }

    bool putUShort(const char *key, uint16_t v) { return putRaw(key, std::to_string(v)); }
    uint16_t getUShort(const char *key, uint16_t def = 0) const {
        return (uint16_t)strtoul(getRaw(key, std::to_string(def)).c_str(), nullptr, 10);
    }

    bool putUChar(const char *key, uint8_t v) { return putRaw(key, std::to_string((unsigned)v)); }
    uint8_t getUChar(const char *key, uint8_t def = 0) const {
        return (uint8_t)strtoul(getRaw(key, std::to_string((unsigned)def)).c_str(), nullptr, 10);
    }

    bool putShort(const char *key, int16_t v) { return putRaw(key, std::to_string(v)); }
    int16_t getShort(const char *key, int16_t def = 0) const {
        return (int16_t)strtol(getRaw(key, std::to_string(def)).c_str(), nullptr, 10);
    }

    bool putFloat(const char *key, float v) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%.6f", (double)v);
        return putRaw(key, buf);
    }
    float getFloat(const char *key, float def = 0) const {
        char defBuf[32];
        snprintf(defBuf, sizeof(defBuf), "%.6f", (double)def);
        return strtof(getRaw(key, defBuf).c_str(), nullptr);
    }

    bool remove(const char *key) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (readOnly_) return false;
        store_.erase(key);
        save();
        return true;
    }

private:
    mutable std::mutex mutex_;
    std::string ns_;
    bool readOnly_ = false;
    std::map<std::string, std::string> store_;

    bool putRaw(const char *key, const std::string &v) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (readOnly_) return false;
        store_[key] = v;
        save();
        return true;
    }
    std::string getRaw(const char *key, const std::string &def) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = store_.find(key);
        return it == store_.end() ? def : it->second;
    }

    std::string filePath() const {
        return std::string(".state/") + g_simStateDir + "/" + ns_ + ".txt";
    }

    void load() {
        store_.clear();
        FILE *f = fopen(filePath().c_str(), "r");
        if (!f) return;
        char line[4096];
        while (fgets(line, sizeof(line), f)) {
            std::string s(line);
            while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
            auto tab = s.find('\t');
            if (tab == std::string::npos) continue;
            store_[s.substr(0, tab)] = s.substr(tab + 1);
        }
        fclose(f);
    }

    void save() const {
        mkdir(".state", 0755);
        mkdir((std::string(".state/") + g_simStateDir).c_str(), 0755);
        FILE *f = fopen(filePath().c_str(), "w");
        if (!f) return;
        for (auto &kv : store_) fprintf(f, "%s\t%s\n", kv.first.c_str(), kv.second.c_str());
        fclose(f);
    }
};
