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

// Real ESP32 NVS survives both deep sleep AND a full power cycle. Unlike
// epaper_clock's Preferences stub (memory-only - fine there, since its one
// pre-seeded config line costs nothing to redo), ours needs the same
// durability: WiFi credentials, the per-device HMAC secret, and registration
// status are expensive to redo (a fresh secret means re-registering with the
// Worker) if you had to reprovision on every single `./sim-<board>` run. So
// each namespace ("eink_config", "ota_health" - see config_manager.cpp /
// ota_health.cpp) is backed by a small text file under
// .state/<SIM_STATE_DIR>/<namespace>.txt (SIM_STATE_DIR is a per-board
// Makefile define, so ee02 and ee04 runs never share state). Not real JSON -
// just "key\tvalue" lines - this is internal-only state, not a wire format.
// config_manager.cpp's ConfigManager holds one Preferences instance for its
// whole lifetime, reused across begin()/end() pairs. In the simulator that
// instance can be touched both from the main thread (normal-mode config
// reads) and from gatt_bridge's connection threads (a provisioning save) -
// unlike real single-core-at-a-time Arduino code, so every public method
// here takes a mutex.
class Preferences {
public:
    void begin(const char *ns, bool readOnly = false) {
        std::lock_guard<std::mutex> lock(mutex_);
        ns_ = ns ? ns : "";
        readOnly_ = readOnly;
        load();
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
        return std::string(".state/") + SIM_STATE_DIR + "/" + ns_ + ".txt";
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
        mkdir((std::string(".state/") + SIM_STATE_DIR).c_str(), 0755);
        FILE *f = fopen(filePath().c_str(), "w");
        if (!f) return;
        for (auto &kv : store_) fprintf(f, "%s\t%s\n", kv.first.c_str(), kv.second.c_str());
        fclose(f);
    }
};
