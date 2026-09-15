#ifndef DEVICE_APP_H
#define DEVICE_APP_H

// Shared firmware core for every board (EE02, EE04, ...). Header-only so it
// compiles as ordinary translation-unit-local code with no extra .cpp to add
// to the build — each board's own PlatformIO environment only ever compiles
// one main.cpp (via build_src_filter), so there is never more than one
// translation unit including this header, and no ODR risk from that.
//
// IMPORTANT: each board's main.cpp MUST `#include "config.h"` (its own,
// board-specific one, e.g. src/ee04/config.h) BEFORE `#include "device_app.h"`.
// This header relies on macros from that file (BOARD_ID, pin numbers, buffer
// size, timeouts, and optionally PIN_POWER) already being defined in the
// translation unit by the time these function bodies are compiled - it does
// NOT #include "config.h" itself, since a quote-include from lib/common/
// would not reliably resolve to a specific board's src/<board>/config.h.
//
// Display-specific code (the `DisplayT` template parameter here) only needs
// to expose begin()/loadImageData()/refresh()/clear()/drawString()/sleep()/
// getBufferSize() - the same shape Spectra6Display and SixColor73Display
// already share. Templating (not a virtual interface) avoids any vtable/
// flash overhead, and each environment only ever instantiates its own board's
// Display type.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include <mbedtls/md.h>
#include <sys/time.h>
#include <time.h>
#include "config_manager.h"
#include "ota_health.h"
#include "version.h"

#ifndef IMAGE_INITIAL_RESPONSE_TIMEOUT_MS
#define IMAGE_INITIAL_RESPONSE_TIMEOUT_MS 60000
#endif

#ifndef IMAGE_STALL_TIMEOUT_MS
#define IMAGE_STALL_TIMEOUT_MS 20000
#endif

#define DEVICE_CONFIG_ENDPOINT "/device_config"
#define MIN_SLEEP_SECONDS 60
#define VALID_UNIX_TIME 1704067200LL  // 2024-01-01 00:00:00 UTC

namespace DeviceApp {

// RTC-persisted state (survives deep sleep) - each board declares its own
// instance with RTC_DATA_ATTR in its own main.cpp (that attribute can't be
// applied safely from inside a shared/templated header), e.g.:
//   RTC_DATA_ATTR DeviceApp::RtcState rtcState;
// A plain aggregate with no constructor, so normal C++ static-storage
// zero-initialization applies on first power-on only - the same guarantee
// the original per-field RTC_DATA_ATTR globals in main.cpp relied on.
struct RtcState {
    int bootCount;
    char lastImageHash[17];  // 16 hex chars + null terminator
    uint8_t lastApBssid[6];
    uint8_t lastApChannel;
    bool haveLastAp;
};

// Regular (non-RTC) per-boot state - re-derived fresh every wake.
struct RunState {
    String firmwareTargetVersion;
    String firmwareTargetSha256;
    float batteryVoltage = -1.0;
};

enum class ImageFetchResult { UNCHANGED, UPDATED, FAILED };

inline String getBaseURL(ConfigManager& configManager) {
    String scheme = configManager.getUseHttps() ? "https://" : "http://";
    return scheme + configManager.getServerHost() + ":" + String(configManager.getServerPort());
}

/**
 * Starts an HTTP(S) request, choosing a plain or TLS transport based on config.
 * TLS certificate validation is intentionally skipped (setInsecure()): this still
 * encrypts traffic against passive eavesdropping, but does not authenticate the
 * server, so it does not protect against an active MITM. That tradeoff is accepted
 * for now to avoid depending on a CA bundle that may not build cleanly on this
 * platform/board without hardware access to verify; hardening to setCACert()/
 * setCACertBundle() is a follow-up, not a blocker for moving off plain HTTP.
 */
inline bool beginRequest(HTTPClient& http, WiFiClientSecure& secureClient, ConfigManager& configManager, const String& url) {
    if (configManager.getUseHttps()) {
        secureClient.setInsecure();
        return http.begin(secureClient, url);
    }
    return http.begin(url);
}

/** Get the WiFi MAC address as a clean string (lowercase, no separators). */
inline String getMACAddressClean() {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char macStr[13];
    snprintf(macStr, sizeof(macStr), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return String(macStr);
}

/**
 * Read battery voltage via the on-board voltage divider.
 * GPIO6 enables the divider circuit, GPIO1 reads the divided voltage - same
 * circuit on every board (EE02's was copied from EE04's reference docs).
 * Returns voltage in volts (e.g., 3.85), or -1.0 if reading seems invalid.
 */
inline float readBatteryVoltage() {
    pinMode(PIN_ADC_ENABLE, OUTPUT);
    digitalWrite(PIN_ADC_ENABLE, HIGH);
    delay(10);  // Let the ADC circuit stabilize

    analogReadResolution(12);

    uint32_t sum = 0;
    for (int i = 0; i < 16; i++) {
        sum += analogRead(PIN_BATTERY_ADC);
    }
    float avgAdc = sum / 16.0;

    digitalWrite(PIN_ADC_ENABLE, LOW);

    float voltage = (avgAdc / 4096.0) * BATTERY_SCALE;

    if (voltage < 0.5 || voltage > 5.0) {
        Serial.printf("Battery: ADC=%.0f, voltage=%.2fV (out of range)\n", avgAdc, voltage);
        return -1.0;
    }

    Serial.printf("Battery: ADC=%.0f, voltage=%.2fV\n", avgAdc, voltage);
    return voltage;
}

inline String bytesToHex(const uint8_t* bytes, size_t len) {
    static const char* hexChars = "0123456789abcdef";
    String result;
    result.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        result += hexChars[bytes[i] >> 4];
        result += hexChars[bytes[i] & 0x0F];
    }
    return result;
}

inline void hexToBytes(const String& hex, uint8_t* out, size_t outLen) {
    for (size_t i = 0; i < outLen; i++) {
        out[i] = static_cast<uint8_t>(strtoul(hex.substring(i * 2, i * 2 + 2).c_str(), nullptr, 16));
    }
}

/**
 * HMAC-SHA256 over `message`, keyed by the device's own secret (see
 * ConfigManager::ensureDeviceSecret()). This — not the mac address, which is
 * public and trivially spoofable — is what proves a request actually came from
 * this device. Mirrors worker/src/lib/device-signature.ts's verification exactly.
 */
inline String computeDeviceSignature(const String& secretHex, const String& message) {
    uint8_t secretBytes[32];
    size_t secretLen = min(secretHex.length() / 2, sizeof(secretBytes));
    hexToBytes(secretHex, secretBytes, secretLen);

    uint8_t hmacResult[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1 /* HMAC */);
    mbedtls_md_hmac_starts(&ctx, secretBytes, secretLen);
    mbedtls_md_hmac_update(&ctx, reinterpret_cast<const uint8_t*>(message.c_str()), message.length());
    mbedtls_md_hmac_finish(&ctx, hmacResult);
    mbedtls_md_free(&ctx);

    return bytesToHex(hmacResult, sizeof(hmacResult));
}

/**
 * Adds identity/auth headers common to every request. `path` must match the
 * route being called (e.g. "/hash", "/image_packed") — it's folded into the
 * signature so a captured signature for one endpoint can't be replayed against
 * another. X-Device-Board is the compiled-in BOARD_ID (see each board's
 * config.h) - the same string used for the GitHub release asset name and the
 * worker's firmware_releases.board column, so the worker can serve the right
 * binary back. X-Device-Secret is only sent pre-registration, to bootstrap the
 * registration QR (see qr-registration.ts) — after the server confirms this
 * device is claimed (device_config's device_id field), it's never sent again.
 *
 * X-Device-Nonce is an NVS-persisted counter, NOT a timestamp — see
 * ConfigManager::nextNonce().
 */
inline void addCommonHeaders(HTTPClient& http, const String& path, ConfigManager& configManager, float batteryVoltage) {
    String macAddress = getMACAddressClean();
    http.addHeader("X-Device-MAC", macAddress);

    if (batteryVoltage > 0) {
        http.addHeader("X-Battery-Voltage", String(batteryVoltage, 2));
    }

    http.addHeader("X-Firmware-Version", FIRMWARE_VERSION);
    http.addHeader("X-Device-Board", BOARD_ID);

    String secret = configManager.getDeviceSecret();
    String nonce = String(configManager.nextNonce());
    String message = macAddress + "|" + path + "|" + nonce;
    String signature = computeDeviceSignature(secret, message);
    http.addHeader("X-Device-Nonce", nonce);
    http.addHeader("X-Device-Signature", signature);

    bool sendingSecret = !configManager.getDeviceRegistered();
    if (sendingSecret) {
        http.addHeader("X-Device-Secret", secret);
    }

    Serial.printf("Request headers -> X-Device-MAC: %s, X-Device-Board: %s, X-Device-Nonce: %s, X-Device-Signature: %s%s\n",
                  macAddress.c_str(), BOARD_ID, nonce.c_str(), signature.c_str(),
                  sendingSecret ? (", X-Device-Secret: " + secret).c_str() : "");
}

/**
 * Downloads /firmware_bin?version=<version>, verifying its SHA-256 against
 * expectedSha256Hex while streaming — before Update.end() commits to booting it —
 * then flashes it to the inactive OTA partition. Caller reboots on success.
 */
inline bool performFirmwareOTA(const String& version, const String& expectedSha256Hex,
                                ConfigManager& configManager, float batteryVoltage) {
    String url = getBaseURL(configManager) + "/firmware_bin?version=" + version;
    Serial.printf("Firmware update available: %s -> %s\n", FIRMWARE_VERSION, version.c_str());
    Serial.printf("Downloading from: %s\n", url.c_str());

    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, configManager, url);
    http.setTimeout(IMAGE_INITIAL_RESPONSE_TIMEOUT_MS);
    addCommonHeaders(http, "/firmware_bin", configManager, batteryVoltage);

    int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("Firmware download failed, HTTP code: %d\n", httpCode);
        http.end();
        return false;
    }

    int contentLength = http.getSize();
    if (contentLength <= 0) {
        Serial.printf("Invalid firmware content length: %d\n", contentLength);
        http.end();
        return false;
    }

    if (!Update.begin(contentLength, U_FLASH)) {
        Serial.printf("Update.begin() failed: %s\n", Update.errorString());
        http.end();
        return false;
    }

    mbedtls_sha256_context shaCtx;
    mbedtls_sha256_init(&shaCtx);
    mbedtls_sha256_starts(&shaCtx, 0);  // 0 = SHA-256 (not the SHA-224 variant)

    WiFiClient* stream = http.getStreamPtr();
    uint8_t buf[2048];
    size_t bytesRead = 0;
    uint32_t startTime = millis();
    uint32_t lastDataTime = startTime;
    bool writeFailed = false;

    while (bytesRead < (size_t)contentLength && http.connected()) {
        size_t available = stream->available();
        if (available > 0) {
            size_t toRead = min(available, sizeof(buf));
            size_t n = stream->readBytes(buf, toRead);
            if (n > 0) {
                mbedtls_sha256_update(&shaCtx, buf, n);
                if (Update.write(buf, n) != n) {
                    Serial.printf("Update.write() failed: %s\n", Update.errorString());
                    writeFailed = true;
                    break;
                }
                bytesRead += n;
                lastDataTime = millis();

                if ((bytesRead % 102400) == 0) {
                    Serial.printf("Firmware downloaded: %d / %d bytes\n", bytesRead, contentLength);
                }
            }
        }
        yield();

        if (millis() - lastDataTime > IMAGE_STALL_TIMEOUT_MS) {
            Serial.printf("Firmware download stalled - no data for %u ms\n", IMAGE_STALL_TIMEOUT_MS);
            break;
        }
    }
    http.end();

    if (writeFailed || bytesRead != (size_t)contentLength) {
        Serial.printf("Incomplete/failed firmware download: %d / %d bytes\n", bytesRead, contentLength);
        mbedtls_sha256_free(&shaCtx);
        Update.abort();
        return false;
    }

    uint8_t digest[32];
    mbedtls_sha256_finish(&shaCtx, digest);
    mbedtls_sha256_free(&shaCtx);
    String actualSha256Hex = bytesToHex(digest, sizeof(digest));

    if (!actualSha256Hex.equalsIgnoreCase(expectedSha256Hex)) {
        Serial.printf("Firmware SHA-256 mismatch! expected=%s actual=%s\n",
                      expectedSha256Hex.c_str(), actualSha256Hex.c_str());
        Update.abort();
        return false;
    }

    if (!Update.end(true)) {
        Serial.printf("Update.end() failed: %s\n", Update.errorString());
        return false;
    }

    Serial.printf("Firmware update verified and flashed in %lu ms\n", millis() - startTime);
    return true;
}

/**
 * Uploads whatever crash/rollback report OtaHealth has queued (see ota_health.h) —
 * a boot-time panic/watchdog reset, a bootloader/self-triggered OTA rollback, or
 * both. Only called once WiFi + an authenticated round trip already succeeded this
 * wake, so there's nothing new to prove here. Leaves the queued report in place on
 * any failure - NVS storage is cheap and it'll just retry next wake.
 */
inline void sendCrashReportIfPending(OtaHealth& otaHealth, ConfigManager& configManager, float batteryVoltage) {
    if (!otaHealth.hasPendingReport()) return;

    String url = getBaseURL(configManager) + "/crash_report";
    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, configManager, url);
    http.setTimeout(HTTP_TIMEOUT_MS);
    addCommonHeaders(http, "/crash_report", configManager, batteryVoltage);
    http.addHeader("Content-Type", "application/json");

    String body = otaHealth.getPendingReportJson();
    int httpCode = http.POST(body);
    http.end();

    if (httpCode == HTTP_CODE_OK || httpCode == 201) {
        Serial.println("Crash report uploaded");
        otaHealth.clearPendingReport();
    } else {
        Serial.printf("Crash report upload failed (HTTP %d) - will retry next wake\n", httpCode);
    }
}

inline bool isClockValid(time_t now = time(nullptr)) {
    return now >= VALID_UNIX_TIME;
}

inline void setClockFromEpoch(time_t epochSeconds) {
    struct timeval tv;
    tv.tv_sec = epochSeconds;
    tv.tv_usec = 0;
    settimeofday(&tv, nullptr);
}

inline int32_t getLocalSecondsOfDay(time_t utcNow, int16_t timezoneOffsetMinutes) {
    int64_t localSeconds = static_cast<int64_t>(utcNow) + static_cast<int64_t>(timezoneOffsetMinutes) * 60LL;
    int32_t secondsOfDay = static_cast<int32_t>(localSeconds % 86400LL);
    if (secondsOfDay < 0) {
        secondsOfDay += 86400;
    }
    return secondsOfDay;
}

inline bool isWithinActiveWindow(time_t utcNow, uint8_t startHour, uint8_t endHour, int16_t timezoneOffsetMinutes) {
    if (startHour == endHour) {
        return true;  // Same start/end means always active.
    }

    int32_t secondsOfDay = getLocalSecondsOfDay(utcNow, timezoneOffsetMinutes);
    int32_t startSeconds = static_cast<int32_t>(startHour) * 3600;
    int32_t endSeconds = static_cast<int32_t>(endHour) * 3600;

    if (startHour < endHour) {
        return secondsOfDay >= startSeconds && secondsOfDay < endSeconds;
    }

    return secondsOfDay >= startSeconds || secondsOfDay < endSeconds;
}

inline uint32_t secondsUntilNextActiveWindow(time_t utcNow, uint8_t startHour, int16_t timezoneOffsetMinutes) {
    int32_t secondsOfDay = getLocalSecondsOfDay(utcNow, timezoneOffsetMinutes);
    int32_t startSeconds = static_cast<int32_t>(startHour) * 3600;

    if (secondsOfDay < startSeconds) {
        return static_cast<uint32_t>(startSeconds - secondsOfDay);
    }

    return static_cast<uint32_t>((86400 - secondsOfDay) + startSeconds);
}

inline uint32_t secondsUntilWindowEnd(time_t utcNow, uint8_t startHour, uint8_t endHour, int16_t timezoneOffsetMinutes) {
    if (startHour == endHour) {
        return UINT32_MAX;
    }

    int32_t secondsOfDay = getLocalSecondsOfDay(utcNow, timezoneOffsetMinutes);
    int32_t startSeconds = static_cast<int32_t>(startHour) * 3600;
    int32_t endSeconds = static_cast<int32_t>(endHour) * 3600;

    if (startHour < endHour) {
        return static_cast<uint32_t>(endSeconds - secondsOfDay);
    }

    if (secondsOfDay >= startSeconds) {
        return static_cast<uint32_t>((86400 - secondsOfDay) + endSeconds);
    }

    return static_cast<uint32_t>(endSeconds - secondsOfDay);
}

inline void printClockStatus(ConfigManager& configManager) {
    time_t now = time(nullptr);
    if (!isClockValid(now)) {
        Serial.println("Clock status: invalid (no recent server time sync yet)");
        return;
    }

    int32_t localSeconds = getLocalSecondsOfDay(now, configManager.getTimezoneOffsetMinutes());
    int localHour = localSeconds / 3600;
    int localMinute = (localSeconds % 3600) / 60;
    bool isActive = isWithinActiveWindow(now,
                                         configManager.getActiveStartHour(),
                                         configManager.getActiveEndHour(),
                                         configManager.getTimezoneOffsetMinutes());

    Serial.printf("Clock status: utc=%lld, local=%02d:%02d, active_window=%s\n",
                  static_cast<long long>(now), localHour, localMinute,
                  isActive ? "yes" : "no");
}

inline uint32_t calculateSleepSeconds(ConfigManager& configManager) {
    uint32_t refreshSeconds = static_cast<uint32_t>(configManager.getSleepMinutes()) * 60U;
    time_t now = time(nullptr);

    if (!isClockValid(now)) {
        Serial.println("Clock invalid - using fixed refresh interval for sleep");
        return max(refreshSeconds, static_cast<uint32_t>(MIN_SLEEP_SECONDS));
    }

    uint8_t activeStart = configManager.getActiveStartHour();
    uint8_t activeEnd = configManager.getActiveEndHour();
    int16_t timezoneOffset = configManager.getTimezoneOffsetMinutes();

    if (!isWithinActiveWindow(now, activeStart, activeEnd, timezoneOffset)) {
        uint32_t untilNextWindow = secondsUntilNextActiveWindow(now, activeStart, timezoneOffset);
        Serial.printf("Outside active window - sleeping until next active start in %lu seconds\n", untilNextWindow);
        return max(untilNextWindow, static_cast<uint32_t>(MIN_SLEEP_SECONDS));
    }

    uint32_t untilWindowEnd = secondsUntilWindowEnd(now, activeStart, activeEnd, timezoneOffset);
    if (refreshSeconds < untilWindowEnd) {
        return max(refreshSeconds, static_cast<uint32_t>(MIN_SLEEP_SECONDS));
    }

    uint32_t untilNextWindow = secondsUntilNextActiveWindow(now, activeStart, timezoneOffset);
    Serial.printf("Next refresh would land in quiet hours - sleeping %lu seconds instead\n", untilNextWindow);
    return max(untilNextWindow, static_cast<uint32_t>(MIN_SLEEP_SECONDS));
}

inline bool syncRemoteConfigAndTime(ConfigManager& configManager, RunState& run) {
    String configUrl = getBaseURL(configManager) + DEVICE_CONFIG_ENDPOINT;
    Serial.printf("Fetching device config from: %s\n", configUrl.c_str());

    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, configManager, configUrl);
    http.setTimeout(HTTP_TIMEOUT_MS);
    addCommonHeaders(http, DEVICE_CONFIG_ENDPOINT, configManager, run.batteryVoltage);

    int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("Device config fetch failed, HTTP code: %d\n", httpCode);
        http.end();
        return false;
    }

    String payload = http.getString();
    http.end();

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, payload);
    if (error) {
        Serial.printf("Failed to parse device config JSON: %s\n", error.c_str());
        return false;
    }

    if (!doc["server_time_epoch"].is<int64_t>()) {
        Serial.println("Device config missing server_time_epoch");
        return false;
    }

    time_t serverEpoch = static_cast<time_t>(doc["server_time_epoch"].as<int64_t>());
    setClockFromEpoch(serverEpoch);
    Serial.printf("Clock synchronized from server epoch: %lld\n", static_cast<long long>(serverEpoch));

    const char* deviceId = doc["device_id"] | "";
    bool nowRegistered = strcasecmp(deviceId, getMACAddressClean().c_str()) == 0;
    if (nowRegistered != configManager.getDeviceRegistered()) {
        configManager.setDeviceRegistered(nowRegistered);
    }

    uint16_t refreshMinutes = configManager.getSleepMinutes();
    uint8_t activeStart = configManager.getActiveStartHour();
    uint8_t activeEnd = configManager.getActiveEndHour();
    int16_t timezoneOffset = configManager.getTimezoneOffsetMinutes();
    bool scheduleChanged = false;

    if (doc["refresh_interval_minutes"].is<int>()) {
        int value = doc["refresh_interval_minutes"].as<int>();
        if (value > 0 && value <= 1440 && value != refreshMinutes) {
            refreshMinutes = static_cast<uint16_t>(value);
            scheduleChanged = true;
        }
    }

    if (doc["active_start_hour"].is<int>()) {
        int value = doc["active_start_hour"].as<int>();
        if (value >= 0 && value <= 23 && value != activeStart) {
            activeStart = static_cast<uint8_t>(value);
            scheduleChanged = true;
        }
    }

    if (doc["active_end_hour"].is<int>()) {
        int value = doc["active_end_hour"].as<int>();
        if (value >= 0 && value <= 23 && value != activeEnd) {
            activeEnd = static_cast<uint8_t>(value);
            scheduleChanged = true;
        }
    }

    if (doc["timezone_offset_minutes"].is<int>()) {
        int value = doc["timezone_offset_minutes"].as<int>();
        if (value >= -720 && value <= 840 && value != timezoneOffset) {
            timezoneOffset = static_cast<int16_t>(value);
            scheduleChanged = true;
        }
    }

    if (scheduleChanged) {
        configManager.setConfig(configManager.getServerHost(),
                                configManager.getServerPort(),
                                configManager.getUseHttps(),
                                configManager.getImageEndpoint(),
                                refreshMinutes,
                                activeStart,
                                activeEnd,
                                timezoneOffset);
        Serial.println("Applied schedule overrides from server");
        configManager.printConfig();
    }

    const char* configSource = doc["config_source"] | "none";
    Serial.printf("Remote config source: %s\n", configSource);

    run.firmwareTargetVersion = "";
    run.firmwareTargetSha256 = "";
    if (doc["firmware_version"].is<const char*>() && doc["firmware_sha256"].is<const char*>()) {
        run.firmwareTargetVersion = doc["firmware_version"].as<String>();
        run.firmwareTargetSha256 = doc["firmware_sha256"].as<String>();
    }

    return true;
}

inline void printWakeupReason() {
    esp_sleep_wakeup_cause_t wakeupReason = esp_sleep_get_wakeup_cause();
    switch (wakeupReason) {
        case ESP_SLEEP_WAKEUP_TIMER:
            Serial.println("Wakeup caused by timer");
            break;
        case ESP_SLEEP_WAKEUP_EXT0:
            Serial.println("Wakeup caused by external signal (RTC_IO)");
            break;
        case ESP_SLEEP_WAKEUP_EXT1:
            Serial.println("Wakeup caused by external signal (RTC_CNTL)");
            break;
        default:
            Serial.printf("Wakeup was not from deep sleep (code: %d)\n", wakeupReason);
            break;
    }
}

/**
 * True only for a genuine deep-sleep timer/pin wakeup — false for a cold boot
 * (power-on, reset button, fresh flash).
 */
inline bool wasDeepSleepWakeup() {
    esp_sleep_wakeup_cause_t wakeupReason = esp_sleep_get_wakeup_cause();
    return wakeupReason == ESP_SLEEP_WAKEUP_TIMER ||
           wakeupReason == ESP_SLEEP_WAKEUP_EXT0 ||
           wakeupReason == ESP_SLEEP_WAKEUP_EXT1;
}

#define CONFIG_BUTTON_HOLD_MS 1000

inline bool checkConfigButton() {
    pinMode(PIN_BUTTON_1, INPUT_PULLUP);

    if (digitalRead(PIN_BUTTON_1) == LOW) {
        Serial.println("Config button pressed - hold for 1 second to enter config mode...");

        uint32_t startTime = millis();
        while (digitalRead(PIN_BUTTON_1) == LOW) {
            if (millis() - startTime >= CONFIG_BUTTON_HOLD_MS) {
                Serial.println("*** CONFIG BUTTON HELD - Entering config mode ***");
                return true;
            }
            delay(50);
        }
        Serial.println("Button released too early - continuing normal operation");
    }

    return false;
}

inline bool connectWiFi(ConfigManager& configManager, RtcState& rtc) {
    String ssid = configManager.getWifiSsid();
    if (ssid.length() == 0) {
        Serial.println("No WiFi credentials configured - skipping connect attempt");
        return false;
    }

    WiFi.mode(WIFI_STA);
    String password = configManager.getWifiPassword();

    // Fast reconnect: skip the AP scan by reusing the channel/BSSID we associated
    // with last time (cached in RTC memory, so it survives deep sleep).
    if (rtc.haveLastAp) {
        Serial.printf("Connecting to WiFi: %s (fast reconnect, channel %d)\n", ssid.c_str(), rtc.lastApChannel);
        WiFi.begin(ssid.c_str(), password.c_str(), rtc.lastApChannel, rtc.lastApBssid);

        uint32_t fastStart = millis();
        while (WiFi.status() != WL_CONNECTED) {
            delay(100);
            if (millis() - fastStart > WIFI_FAST_RECONNECT_TIMEOUT_MS) {
                Serial.println("\nFast reconnect failed - falling back to full scan");
                WiFi.disconnect();
                rtc.haveLastAp = false;
                break;
            }
        }
    }

    if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("Connecting to WiFi: %s\n", ssid.c_str());
        WiFi.begin(ssid.c_str(), password.c_str());

        uint32_t startTime = millis();
        while (WiFi.status() != WL_CONNECTED) {
            delay(500);
            Serial.print(".");

            if (millis() - startTime > WIFI_TIMEOUT_MS) {
                Serial.println("\nWiFi connection timeout!");
                return false;
            }
        }
        Serial.println();
    }

    Serial.printf("Connected! IP: %s\n", WiFi.localIP().toString().c_str());

    uint8_t* bssid = WiFi.BSSID();
    if (bssid != nullptr) {
        memcpy(rtc.lastApBssid, bssid, sizeof(rtc.lastApBssid));
        rtc.lastApChannel = WiFi.channel();
        rtc.haveLastAp = true;
    }

    return true;
}

inline void disconnectWiFi() {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    Serial.println("WiFi disconnected");
}

/**
 * Fetches the pending image, folding the old separate hash pre-check into this
 * same request via ?known_hash= (see worker/src/routes/image-packed.ts). A 304
 * means the server confirmed the image is unchanged; the display buffer is only
 * allocated and display.begin() only called once we know we actually have bytes
 * to show.
 */
template <typename DisplayT>
ImageFetchResult fetchAndDisplayImage(DisplayT& display, ConfigManager& configManager, RtcState& rtc, RunState& run) {
    String url = configManager.getFullURL();
    if (rtc.lastImageHash[0] != '\0') {
        url += (url.indexOf('?') >= 0 ? "&" : "?");
        url += "known_hash=";
        url += rtc.lastImageHash;
    }
    Serial.printf("Fetching image from: %s\n", url.c_str());

    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, configManager, url);
    http.setTimeout(IMAGE_INITIAL_RESPONSE_TIMEOUT_MS);
    addCommonHeaders(http, configManager.getImageEndpoint(), configManager, run.batteryVoltage);

    int httpCode = http.GET();

    if (httpCode == 304) {
        Serial.println("Server reports image unchanged (304) - skipping download");
        http.end();
        return ImageFetchResult::UNCHANGED;
    }

    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("HTTP GET failed, code: %d\n", httpCode);
        http.end();
        return ImageFetchResult::FAILED;
    }

    String responseImageHash = http.header("X-Image-Hash");
    String responseImageName = http.header("X-Image-Name");
    String responseDeviceId = http.header("X-Device-ID");
    if (responseImageName.length() > 0 || responseImageHash.length() > 0 || responseDeviceId.length() > 0) {
        Serial.printf("Response headers: X-Image-Name=%s, X-Image-Hash=%s, X-Device-ID=%s\n",
                      responseImageName.length() > 0 ? responseImageName.c_str() : "(none)",
                      responseImageHash.length() > 0 ? responseImageHash.c_str() : "(none)",
                      responseDeviceId.length() > 0 ? responseDeviceId.c_str() : "(none)");
    }

    int contentLength = http.getSize();
    Serial.printf("Content length: %d bytes\n", contentLength);

    if (contentLength <= 0 || contentLength > (int)display.getBufferSize()) {
        Serial.printf("Invalid content length: %d (expected %d)\n", contentLength, (int)display.getBufferSize());
        http.end();
        return ImageFetchResult::FAILED;
    }

    // Stream directly into the display's own buffer rather than a separate
    // temp allocation + copy - on a PSRAM-less board (EE04) a second
    // full-size buffer alongside the display's own wouldn't reliably fit in
    // ~320KB of internal SRAM once WiFi/TLS/BLE overhead is accounted for,
    // and it's wasted PSRAM churn on EE02 too. display.begin() must run
    // first so the buffer is actually allocated/valid before writing into it.
    if (!display.begin()) {
        Serial.println("Display initialization failed!");
        http.end();
        return ImageFetchResult::FAILED;
    }
    uint8_t* imageBuffer = display.getBuffer();

    WiFiClient* stream = http.getStreamPtr();
    size_t bytesRead = 0;
    uint32_t startTime = millis();
    uint32_t lastDataTime = startTime;

    while (bytesRead < (size_t)contentLength && http.connected()) {
        size_t available = stream->available();
        if (available > 0) {
            size_t toRead = min(available, (size_t)(contentLength - bytesRead));
            size_t n = stream->readBytes(imageBuffer + bytesRead, toRead);
            bytesRead += n;
            lastDataTime = millis();

            if ((bytesRead % 102400) == 0) {
                Serial.printf("Downloaded: %d / %d bytes\n", bytesRead, contentLength);
            }
        }
        yield();

        if (millis() - lastDataTime > IMAGE_STALL_TIMEOUT_MS) {
            Serial.printf("Download stalled - no data for %u ms\n", IMAGE_STALL_TIMEOUT_MS);
            break;
        }
    }

    http.end();

    Serial.printf("Downloaded %d bytes in %lu ms\n", bytesRead, millis() - startTime);

    if (bytesRead != (size_t)contentLength) {
        Serial.println("Incomplete download! Display buffer now holds a partial/garbled image - "
                        "will retry next wake since lastImageHash is left unset below.");
        // display.begin() above already powered the panel on - power it back
        // down without drawing the partial buffer, or it stays powered (and
        // draining battery) for the whole sleep interval on a board with no
        // PIN_POWER rail-cut (e.g. EE04).
        display.sleep();
        return ImageFetchResult::FAILED;
    }

    display.refresh();

    if (responseImageHash.length() == 16) {
        strncpy(rtc.lastImageHash, responseImageHash.c_str(), 16);
        rtc.lastImageHash[16] = '\0';
    } else {
        Serial.println("Warning: response had no X-Image-Hash - next wake will re-fetch this image");
    }
    Serial.printf("Committed displayed image hash: %s\n", rtc.lastImageHash[0] ? rtc.lastImageHash : "(none)");

    return ImageFetchResult::UPDATED;
}

inline void enterDeepSleep(uint32_t sleepSeconds) {
    uint32_t sleepMinutes = sleepSeconds / 60;
    uint32_t remainderSeconds = sleepSeconds % 60;
    Serial.printf("Entering deep sleep for %lu minutes %lu seconds...\n", sleepMinutes, remainderSeconds);

    uint64_t sleepTime = static_cast<uint64_t>(sleepSeconds) * 1000000ULL;
    esp_sleep_enable_timer_wakeup(sleepTime);

#ifdef PIN_POWER
    // Turn off display power to save energy - only boards with a dedicated
    // power-enable pin (currently just EE02) need this.
    digitalWrite(PIN_POWER, LOW);
#endif

    Serial.println("Going to sleep now...");
    Serial.flush();
    esp_deep_sleep_start();
}

/**
 * The full normal-operation wake cycle: WiFi, device_config/time sync, OTA
 * check, quiet-hours check, image fetch/display, sleep. Each board's own
 * main.cpp calls this from setup() after handling config-mode/first-boot
 * cases itself (those still need board-specific display layout - see
 * showConfigModeScreen() in each board's main.cpp).
 */
template <typename DisplayT>
void runNormalMode(DisplayT& display, ConfigManager& configManager, OtaHealth& otaHealth, RtcState& rtc, RunState& run) {
    Serial.println("\n========================================");
    Serial.println("NORMAL OPERATION MODE");
    Serial.println("========================================\n");

    // Read battery voltage before WiFi (ADC can be noisy during WiFi)
    run.batteryVoltage = readBatteryVoltage();

    if (!connectWiFi(configManager, rtc)) {
        Serial.println("WiFi connection failed!");
        disconnectWiFi();
        enterDeepSleep(calculateSleepSeconds(configManager));
        return;
    }

    bool remoteConfigSynced = syncRemoteConfigAndTime(configManager, run);
    printClockStatus(configManager);

    if (remoteConfigSynced) {
        // A successful authenticated round trip is our proof this firmware actually
        // works - cancel any pending OTA rollback watch and flush any queued crash/
        // rollback report now that we have connectivity. See ota_health.h.
        otaHealth.confirmHealthy();
        sendCrashReportIfPending(otaHealth, configManager, run.batteryVoltage);
    }

    // Firmware OTA check happens regardless of quiet hours — it's rare and the
    // device is already awake and connected. firmwareTargetVersion is only ever
    // non-empty when this device's channel (stable/beta - set in /admin, not
    // a device-side concept) resolves to a release for THIS board (see
    // syncRemoteConfigAndTime / worker's lib/firmware-target.ts).
    if (run.firmwareTargetVersion.length() > 0 && run.firmwareTargetVersion != FIRMWARE_VERSION) {
        if (performFirmwareOTA(run.firmwareTargetVersion, run.firmwareTargetSha256, configManager, run.batteryVoltage)) {
            Serial.println("Rebooting into new firmware...");
            otaHealth.recordOtaAttempt(FIRMWARE_VERSION, run.firmwareTargetVersion);
            disconnectWiFi();
            ESP.restart();
        } else {
            Serial.println("Firmware OTA failed - continuing with current firmware this cycle");
        }
    }

    if (wasDeepSleepWakeup() &&
        isClockValid() &&
        !isWithinActiveWindow(time(nullptr),
                              configManager.getActiveStartHour(),
                              configManager.getActiveEndHour(),
                              configManager.getTimezoneOffsetMinutes())) {
        Serial.println("Currently in quiet hours - skipping image fetch");
        disconnectWiFi();
        enterDeepSleep(calculateSleepSeconds(configManager));
        return;
    }

    switch (fetchAndDisplayImage(display, configManager, rtc, run)) {
        case ImageFetchResult::UNCHANGED:
            Serial.println("Image unchanged - going back to sleep");
            break;
        case ImageFetchResult::UPDATED:
            break;
        case ImageFetchResult::FAILED:
            Serial.println("Image fetch/display failed - keeping previous image on display");
            break;
    }

    disconnectWiFi();
    enterDeepSleep(calculateSleepSeconds(configManager));
}

} // namespace DeviceApp

#endif // DEVICE_APP_H
