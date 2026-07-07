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
#include "config.h"
#include "display.h"
#include "config_manager.h"
#include "ble_provisioning.h"
#include "version.h"

#ifndef IMAGE_INITIAL_RESPONSE_TIMEOUT_MS
#if defined(IMAGE_HTTP_TIMEOUT_MS) && (IMAGE_HTTP_TIMEOUT_MS <= 65535)
#define IMAGE_INITIAL_RESPONSE_TIMEOUT_MS IMAGE_HTTP_TIMEOUT_MS
#else
#define IMAGE_INITIAL_RESPONSE_TIMEOUT_MS 60000
#endif
#endif

#ifndef IMAGE_STALL_TIMEOUT_MS
#if defined(IMAGE_HTTP_TIMEOUT_MS) && (IMAGE_HTTP_TIMEOUT_MS <= 65535)
#define IMAGE_STALL_TIMEOUT_MS IMAGE_HTTP_TIMEOUT_MS
#else
#define IMAGE_STALL_TIMEOUT_MS 20000
#endif
#endif

// Global instances
Spectra6Display display;
ConfigManager configManager;
BLEProvisioning bleProvisioning(configManager);

// Boot count stored in RTC memory (survives deep sleep)
RTC_DATA_ATTR int bootCount = 0;

// Last image hash stored in RTC memory (survives deep sleep)
// Used to skip download if image hasn't changed
RTC_DATA_ATTR char lastImageHash[17] = {0};  // 16 chars + null terminator
char pendingImageHash[17] = {0};

// Firmware target reported by /device_config this wake, if any (see
// syncRemoteConfigAndTime() and version.h). Empty means "no target set" —
// never do OTA in that case, not even to re-flash the same version.
String firmwareTargetVersion = "";
String firmwareTargetSha256 = "";

// Battery voltage (read once per boot, sent to server with requests)
float batteryVoltage = -1.0;

// Configuration mode: hold Button 1 during boot for 1 second
#define CONFIG_BUTTON_HOLD_MS 1000
#define DEVICE_CONFIG_ENDPOINT "/device_config"
#define MIN_SLEEP_SECONDS 60
#define VALID_UNIX_TIME 1704067200LL  // 2024-01-01 00:00:00 UTC

String getBaseURL() {
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
bool beginRequest(HTTPClient& http, WiFiClientSecure& secureClient, const String& url) {
    if (configManager.getUseHttps()) {
        secureClient.setInsecure();
        return http.begin(secureClient, url);
    }
    return http.begin(url);
}

/**
 * Get the WiFi MAC address as a clean string (lowercase, no separators).
 * Used to identify this device to the image server.
 */
String getMACAddressClean() {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char macStr[13];
    snprintf(macStr, sizeof(macStr), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return String(macStr);
}

/**
 * Read battery voltage via the on-board voltage divider.
 * GPIO6 enables the divider circuit, GPIO1 reads the divided voltage.
 * Returns voltage in volts (e.g., 3.85), or -1.0 if reading seems invalid.
 */
float readBatteryVoltage() {
    pinMode(PIN_ADC_ENABLE, OUTPUT);
    digitalWrite(PIN_ADC_ENABLE, HIGH);
    delay(10);  // Let the ADC circuit stabilize

    analogReadResolution(12);

    // Average 16 samples to filter noise
    uint32_t sum = 0;
    for (int i = 0; i < 16; i++) {
        sum += analogRead(PIN_BATTERY_ADC);
    }
    float avgAdc = sum / 16.0;

    // Disable the voltage divider to save power
    digitalWrite(PIN_ADC_ENABLE, LOW);

    float voltage = (avgAdc / 4096.0) * BATTERY_SCALE;

    // Sanity check: LiPo range is roughly 2.5V-4.3V
    if (voltage < 0.5 || voltage > 5.0) {
        Serial.printf("Battery: ADC=%.0f, voltage=%.2fV (out of range)\n", avgAdc, voltage);
        return -1.0;
    }

    Serial.printf("Battery: ADC=%.0f, voltage=%.2fV\n", avgAdc, voltage);
    return voltage;
}

String bytesToHex(const uint8_t* bytes, size_t len) {
    static const char* hexChars = "0123456789abcdef";
    String result;
    result.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        result += hexChars[bytes[i] >> 4];
        result += hexChars[bytes[i] & 0x0F];
    }
    return result;
}

void hexToBytes(const String& hex, uint8_t* out, size_t outLen) {
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
String computeDeviceSignature(const String& secretHex, const String& message) {
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
 * another. X-Device-Secret is only sent pre-registration, to bootstrap the
 * registration QR (see qr-registration.ts) — after the server confirms this
 * device is claimed (device_config's device_id field), it's never sent again.
 *
 * X-Device-Nonce is an NVS-persisted counter, NOT a timestamp — time(nullptr)
 * was tried first and doesn't survive a real power loss (deep sleep keeps the
 * RTC running, a brownout/reset doesn't), so a device that ever loses power
 * would send a "time" behind what the server already had on file and get
 * stuck 401ing forever. See ConfigManager::nextNonce().
 */
void addCommonHeaders(HTTPClient& http, const String& path) {
    String macAddress = getMACAddressClean();
    http.addHeader("X-Device-MAC", macAddress);

    if (batteryVoltage > 0) {
        http.addHeader("X-Battery-Voltage", String(batteryVoltage, 2));
    }

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

    // Logged so a request can be replayed by hand with curl, e.g.:
    //   curl -H "X-Device-MAC: <mac>" -H "X-Device-Nonce: <nonce>" \
    //        -H "X-Device-Signature: <signature>" <url>
    // Note X-Device-Nonce is single-use — the server rejects any nonce that
    // isn't strictly greater than the last one it accepted for this mac, so a
    // logged request can only be replayed once, immediately, before the real
    // device's next wake advances the counter past it.
    Serial.printf("Request headers -> X-Device-MAC: %s, X-Device-Nonce: %s, X-Device-Signature: %s%s\n",
                  macAddress.c_str(), nonce.c_str(), signature.c_str(),
                  sendingSecret ? (", X-Device-Secret: " + secret).c_str() : "");
}

/**
 * Downloads /firmware_bin?version=<version>, verifying its SHA-256 against
 * expectedSha256Hex while streaming — before Update.end() commits to booting it —
 * then flashes it to the inactive OTA partition. Caller reboots on success.
 *
 * A corrupt/incomplete download or hash mismatch aborts the write and leaves the
 * currently-running firmware untouched, so a bad transfer can't brick the device.
 * It does NOT protect against a *logically* broken release (one that flashes clean
 * but crashes or loops on boot) — this board's stock Arduino/ESP-IDF build doesn't
 * have automatic rollback-on-crash enabled. The safety net for that case is staged
 * rollout: target one device's MAC in /admin before promoting to 'default'/'global'.
 */
bool performFirmwareOTA(const String& version, const String& expectedSha256Hex) {
    String url = getBaseURL() + "/firmware_bin?version=" + version;
    Serial.printf("Firmware update available: %s -> %s\n", FIRMWARE_VERSION, version.c_str());
    Serial.printf("Downloading from: %s\n", url.c_str());

    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, url);
    http.setTimeout(IMAGE_INITIAL_RESPONSE_TIMEOUT_MS);
    addCommonHeaders(http, "/firmware_bin");

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

bool isClockValid(time_t now = time(nullptr)) {
    return now >= VALID_UNIX_TIME;
}

void setClockFromEpoch(time_t epochSeconds) {
    struct timeval tv;
    tv.tv_sec = epochSeconds;
    tv.tv_usec = 0;
    settimeofday(&tv, nullptr);
}

int32_t getLocalSecondsOfDay(time_t utcNow, int16_t timezoneOffsetMinutes) {
    int64_t localSeconds = static_cast<int64_t>(utcNow) + static_cast<int64_t>(timezoneOffsetMinutes) * 60LL;
    int32_t secondsOfDay = static_cast<int32_t>(localSeconds % 86400LL);
    if (secondsOfDay < 0) {
        secondsOfDay += 86400;
    }
    return secondsOfDay;
}

bool isWithinActiveWindow(time_t utcNow, uint8_t startHour, uint8_t endHour, int16_t timezoneOffsetMinutes) {
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

uint32_t secondsUntilNextActiveWindow(time_t utcNow, uint8_t startHour, int16_t timezoneOffsetMinutes) {
    int32_t secondsOfDay = getLocalSecondsOfDay(utcNow, timezoneOffsetMinutes);
    int32_t startSeconds = static_cast<int32_t>(startHour) * 3600;

    if (secondsOfDay < startSeconds) {
        return static_cast<uint32_t>(startSeconds - secondsOfDay);
    }

    return static_cast<uint32_t>((86400 - secondsOfDay) + startSeconds);
}

uint32_t secondsUntilWindowEnd(time_t utcNow, uint8_t startHour, uint8_t endHour, int16_t timezoneOffsetMinutes) {
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

void printClockStatus() {
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

uint32_t calculateSleepSeconds() {
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

bool syncRemoteConfigAndTime() {
    String configUrl = getBaseURL() + DEVICE_CONFIG_ENDPOINT;
    Serial.printf("Fetching device config from: %s\n", configUrl.c_str());

    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, configUrl);
    http.setTimeout(HTTP_TIMEOUT_MS);
    addCommonHeaders(http, DEVICE_CONFIG_ENDPOINT);

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

    // device_id echoes back our own mac once the server has bound a secret to
    // it (see resolveDeviceKey() in auth-device.ts); it's 'default' otherwise.
    // Flipping this both ways keeps us self-healing if an admin deletes the
    // device server-side — we start advertising X-Device-Secret again so it
    // can be reclaimed via the registration QR.
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

    // Only set when an admin has explicitly targeted a firmware version somewhere
    // in the fallback chain (device MAC -> 'default' -> 'global') — see
    // lib/firmware-target.ts. Missing fields here mean "leave firmware alone."
    firmwareTargetVersion = "";
    firmwareTargetSha256 = "";
    if (doc["firmware_version"].is<const char*>() && doc["firmware_sha256"].is<const char*>()) {
        firmwareTargetVersion = doc["firmware_version"].as<String>();
        firmwareTargetSha256 = doc["firmware_sha256"].as<String>();
    }

    return true;
}

void printWakeupReason() {
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
 * (power-on, reset button, fresh flash). Used to let quiet hours only skip the
 * fetch on a *scheduled* wake, since a cold boot means the display might not be
 * showing anything meaningful yet and is worth populating once regardless of
 * the active window; the next real deep-sleep wake goes back to respecting it.
 */
bool wasDeepSleepWakeup() {
    esp_sleep_wakeup_cause_t wakeupReason = esp_sleep_get_wakeup_cause();
    return wakeupReason == ESP_SLEEP_WAKEUP_TIMER ||
           wakeupReason == ESP_SLEEP_WAKEUP_EXT0 ||
           wakeupReason == ESP_SLEEP_WAKEUP_EXT1;
}

bool checkConfigButton() {
    // Configure button pin with internal pull-up
    pinMode(PIN_BUTTON_1, INPUT_PULLUP);

    // Check if button is pressed (LOW = pressed)
    if (digitalRead(PIN_BUTTON_1) == LOW) {
        Serial.println("Config button pressed - hold for 1 second to enter config mode...");

        // Wait and check if button is held for the required duration
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

bool connectWiFi() {
    String ssid = configManager.getWifiSsid();
    if (ssid.length() == 0) {
        Serial.println("No WiFi credentials configured - skipping connect attempt");
        return false;
    }
    Serial.printf("Connecting to WiFi: %s\n", ssid.c_str());

    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), configManager.getWifiPassword().c_str());

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
    Serial.printf("Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    return true;
}

void disconnectWiFi() {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    Serial.println("WiFi disconnected");
}

/**
 * Check if the image on the server has changed by comparing hashes.
 *
 * @return true if image has changed (or if check failed), false if unchanged
 */
bool checkImageChanged() {
    // Build hash endpoint URL from config
    String hashUrl = getBaseURL() + "/hash";

    Serial.printf("Checking image hash at: %s\n", hashUrl.c_str());
    Serial.printf("Last known hash: %s\n", lastImageHash[0] ? lastImageHash : "(none)");

    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, hashUrl);
    http.setTimeout(HTTP_TIMEOUT_MS);
    addCommonHeaders(http, "/hash");

    int httpCode = http.GET();

    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("Hash check failed, HTTP code: %d\n", httpCode);
        http.end();
        return true;  // Assume changed if we can't check
    }

    String newHash = http.getString();
    http.end();

    // Validate hash length (should be 16 characters)
    if (newHash.length() != 16) {
        Serial.printf("Invalid hash length: %d\n", newHash.length());
        return true;  // Assume changed if invalid
    }

    Serial.printf("Server hash: %s\n", newHash.c_str());

    // Compare with stored hash
    if (strcmp(newHash.c_str(), lastImageHash) == 0) {
        Serial.println("Image unchanged - skipping download");
        pendingImageHash[0] = '\0';
        return false;  // No change
    }

    Serial.println("Image changed - will download new image");
    strncpy(pendingImageHash, newHash.c_str(), 16);
    pendingImageHash[16] = '\0';

    return true;  // Changed
}

bool fetchAndDisplayImage() {
    // Allocate buffer in PSRAM for the image
    uint8_t* imageBuffer = (uint8_t*)ps_malloc(BUFFER_SIZE);
    if (imageBuffer == nullptr) {
        Serial.println("Failed to allocate image buffer!");
        return false;
    }

    // Get URL from config manager
    String url = configManager.getFullURL();
    Serial.printf("Fetching image from: %s\n", url.c_str());

    HTTPClient http;
    WiFiClientSecure secureClient;
    beginRequest(http, secureClient, url);
    http.setTimeout(IMAGE_INITIAL_RESPONSE_TIMEOUT_MS);
    addCommonHeaders(http, configManager.getImageEndpoint());

    int httpCode = http.GET();

    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("HTTP GET failed, code: %d\n", httpCode);
        free(imageBuffer);
        http.end();
        return false;
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

    if (contentLength <= 0 || contentLength > BUFFER_SIZE) {
        Serial.printf("Invalid content length: %d (expected %d)\n", contentLength, BUFFER_SIZE);
        free(imageBuffer);
        http.end();
        return false;
    }

    // Stream the response directly into our buffer
    WiFiClient* stream = http.getStreamPtr();
    size_t bytesRead = 0;
    uint32_t startTime = millis();
    uint32_t lastDataTime = startTime;

    while (bytesRead < contentLength && http.connected()) {
        size_t available = stream->available();
        if (available > 0) {
            size_t toRead = min(available, (size_t)(contentLength - bytesRead));
            size_t read = stream->readBytes(imageBuffer + bytesRead, toRead);
            bytesRead += read;
            lastDataTime = millis();

            // Progress update every 100KB
            if ((bytesRead % 102400) == 0) {
                Serial.printf("Downloaded: %d / %d bytes\n", bytesRead, contentLength);
            }
        }
        yield();

        // Abort only if the stream stops producing data for too long.
        if (millis() - lastDataTime > IMAGE_STALL_TIMEOUT_MS) {
            Serial.printf("Download stalled - no data for %u ms\n", IMAGE_STALL_TIMEOUT_MS);
            break;
        }
    }

    http.end();

    Serial.printf("Downloaded %d bytes in %lu ms\n", bytesRead, millis() - startTime);

    if (bytesRead != contentLength) {
        Serial.println("Incomplete download!");
        free(imageBuffer);
        return false;
    }

    // Load image data into display buffer
    display.loadImageData(imageBuffer, bytesRead);

    // Free the temporary buffer
    free(imageBuffer);

    // Refresh the display
    display.refresh();

    if (responseImageHash.length() == 16) {
        strncpy(lastImageHash, responseImageHash.c_str(), 16);
        lastImageHash[16] = '\0';
    } else if (pendingImageHash[0] != '\0') {
        strncpy(lastImageHash, pendingImageHash, 16);
        lastImageHash[16] = '\0';
    }

    if (pendingImageHash[0] != '\0' && responseImageHash.length() == 16 &&
        strcmp(pendingImageHash, responseImageHash.c_str()) != 0) {
        Serial.printf("Warning: pending hash %s did not match response hash %s\n",
                      pendingImageHash, responseImageHash.c_str());
    }
    pendingImageHash[0] = '\0';
    Serial.printf("Committed displayed image hash: %s\n", lastImageHash[0] ? lastImageHash : "(none)");

    return true;
}

void enterDeepSleep(uint32_t sleepSeconds) {
    uint32_t sleepMinutes = sleepSeconds / 60;
    uint32_t remainderSeconds = sleepSeconds % 60;
    Serial.printf("Entering deep sleep for %lu minutes %lu seconds...\n", sleepMinutes, remainderSeconds);

    // Configure timer wakeup
    uint64_t sleepTime = static_cast<uint64_t>(sleepSeconds) * 1000000ULL;
    esp_sleep_enable_timer_wakeup(sleepTime);

    // Turn off display power to save energy
    digitalWrite(PIN_POWER, LOW);

    // Enter deep sleep
    Serial.println("Going to sleep now...");
    Serial.flush();
    esp_deep_sleep_start();
}

void runConfigMode() {
    Serial.println("\n========================================");
    Serial.println("CONFIGURATION MODE (Bluetooth)");
    Serial.println("========================================\n");

    bleProvisioning.start();
    // getBaseURL() reflects whatever server is currently configured (the compiled-in
    // default on a never-provisioned device) — this is where /provision is served
    // from, not something the device itself hosts.
    Serial.printf("Pair over Bluetooth (device name 'EInk-Setup') from %s/provision to configure WiFi/server settings\n",
                  getBaseURL().c_str());

    // Runs until BLEProvisioning triggers a reboot (see handleCommand("save")).
    while (true) {
        bleProvisioning.loop();
        delay(10);
    }
}

void runNormalMode() {
    Serial.println("\n========================================");
    Serial.println("NORMAL OPERATION MODE");
    Serial.println("========================================\n");

    // Read battery voltage before WiFi (ADC can be noisy during WiFi)
    batteryVoltage = readBatteryVoltage();

    // Connect to WiFi first (needed for hash check)
    if (!connectWiFi()) {
        Serial.println("WiFi connection failed!");
        // Keep previous image, just go to sleep
        disconnectWiFi();
        enterDeepSleep(calculateSleepSeconds());
    }

    syncRemoteConfigAndTime();
    printClockStatus();

    // Firmware OTA check happens regardless of quiet hours — it's rare and the
    // device is already awake and connected. firmwareTargetVersion is only ever
    // non-empty when an admin explicitly set a target (see syncRemoteConfigAndTime).
    if (firmwareTargetVersion.length() > 0 && firmwareTargetVersion != FIRMWARE_VERSION) {
        if (performFirmwareOTA(firmwareTargetVersion, firmwareTargetSha256)) {
            Serial.println("Rebooting into new firmware...");
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
        Serial.println("Currently in quiet hours - skipping hash/image fetch");
        disconnectWiFi();
        enterDeepSleep(calculateSleepSeconds());
    }

    // Check if image has changed before downloading
    if (!checkImageChanged()) {
        Serial.println("Image unchanged - going back to sleep");
        disconnectWiFi();
        enterDeepSleep(calculateSleepSeconds());
    }

    // Image has changed - initialize display and update
    if (!display.begin()) {
        Serial.println("Display initialization failed!");
        disconnectWiFi();
        delay(5000);
        ESP.restart();
    }

    // Fetch and display image
    if (!fetchAndDisplayImage()) {
        Serial.println("Image fetch/display failed!");
        // Keep previous image on display
    }

    // Disconnect WiFi to save power
    disconnectWiFi();

    // Enter deep sleep
    enterDeepSleep(calculateSleepSeconds());
}

void setup() {
    Serial.begin(115200);
    delay(1000);  // Give serial time to connect

    Serial.println("\n========================================");
    Serial.println("Seeed EE02 E-Ink Display Firmware");
    Serial.println("========================================");

    bootCount++;
    Serial.printf("Boot count: %d\n", bootCount);
    printWakeupReason();

    // Initialize configuration manager
    configManager.begin();
    configManager.ensureDeviceSecret();

    // Check if config button (Button 1 / GPIO2) is held to enter config mode
    if (checkConfigButton()) {
        runConfigMode();
        // runConfigMode never returns
    }

    // First boot (or after an NVS reset) has no WiFi credentials yet, so there's
    // nothing useful runNormalMode() can do — go straight to provisioning instead
    // of silently failing to connect every wake cycle until someone notices.
    if (configManager.getWifiSsid().length() == 0) {
        Serial.println("No WiFi credentials configured - entering config mode automatically");
        runConfigMode();
        // runConfigMode never returns
    }

    // Normal operation
    runNormalMode();
}

void loop() {
    // This should never be reached due to deep sleep
    delay(1000);
}
