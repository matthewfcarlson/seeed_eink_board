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
#include <Update.h>
#include <mbedtls/sha256.h>
#include <mbedtls/md.h>
// Before <ArduinoJson.h> deliberately: on the macOS simulator, this
// transitively pulls in Security.framework (see
// firmware/simulator/stubs/mbedtls/ecp.h), whose MacTypes.h declares a
// global `Ptr` typedef. ArduinoJson.h ends with `using namespace
// ArduinoJson;`, which injects vendor/ArduinoJson's own `ArduinoJson::Ptr`
// class template into unqualified lookup — if that happens first,
// MacTypes.h's later (header-guarded, so only matters on first processing)
// `typedef Ptr* Handle` becomes ambiguous between the two. Real hardware
// builds are unaffected either way (no Security.framework there), but this
// order must not be swapped back without re-checking the simulator build.
#include <mbedtls/ecp.h>
#include <mbedtls/ecdh.h>
#include <mbedtls/gcm.h>
#include <ArduinoJson.h>
#include <sys/time.h>
#include <time.h>
#include "config_manager.h"
#include "ota_health.h"
#include "version.h"
// Packed-blob compression (see root CLAUDE.md's "Encrypted Image Buckets" ->
// packed-blob compression plan): a single-file, inflate-only extract of
// miniz's tinfl - see that header's own comment for provenance.
#include "tinfl.h"

// Encrypted image buckets (see root CLAUDE.md's plan): the device's own P-256
// keypair is generated once (ensureSharingKeyPair()) and used to unwrap each
// assigned bucket's AES-256-GCM content key (unwrapBucketKeys(), called from
// syncRemoteConfigAndTime() below) before fetchAndDisplayImage() can decrypt
// anything. A device can subscribe to more than one bucket at once — see
// worker/src/db/schema.sql's device_buckets — so this is a small fixed array,
// not a single key.
#define MAX_BUCKET_KEYS 8
#define BUCKET_KEY_BYTES 32

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
struct BucketKey {
    String bucketId;
    // Which of the bucket's key generations this wrap is for — see
    // migrations/0016_bucket_key_rotation.sql. A device mid-rotation can hold
    // both an old and new key for the SAME bucketId at once (two slots, two
    // key_versions), so lookups must match on both fields together, never
    // bucketId alone.
    int keyVersion = 1;
    uint8_t key[BUCKET_KEY_BYTES];
};

struct RunState {
    String firmwareTargetVersion;
    String firmwareTargetSha256;
    float batteryVoltage = -1.0;
    // Unwrapped fresh every wake by unwrapBucketKeys() (called from
    // syncRemoteConfigAndTime()) — never persisted, same as everything else
    // here; re-deriving via ECDH+HKDF each wake is cheap and means a dropped
    // bucket assignment takes effect immediately rather than needing an RTC
    // invalidation path.
    BucketKey bucketKeys[MAX_BUCKET_KEYS];
    int bucketKeyCount = 0;
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

// Standard (not URL-safe) base64, matching worker/src/client/crypto.ts's
// toBase64()/fromBase64() — every WrappedKey field (ephemeral_pub, nonce,
// ciphertext) and the X-Device-Sharing-Public-Key header use this alphabet,
// not the base64url one the invite-link fragment uses (that decode only ever
// happens in the browser, never here).
inline String bytesToBase64(const uint8_t* data, size_t len) {
    static const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    String out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t chunk = (uint32_t)data[i] << 16;
        if (i + 1 < len) chunk |= (uint32_t)data[i + 1] << 8;
        if (i + 2 < len) chunk |= (uint32_t)data[i + 2];
        out += alphabet[(chunk >> 18) & 0x3F];
        out += alphabet[(chunk >> 12) & 0x3F];
        out += (i + 1 < len) ? alphabet[(chunk >> 6) & 0x3F] : '=';
        out += (i + 2 < len) ? alphabet[chunk & 0x3F] : '=';
    }
    return out;
}

/** Returns the decoded byte count, or 0 on a malformed input/oversized output
 *  (never partially fills `out` in that case). */
inline size_t base64Decode(const String& b64, uint8_t* out, size_t outCapacity) {
    auto value = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    size_t outLen = 0;
    uint32_t buffer = 0;
    int bitsCollected = 0;
    for (size_t i = 0; i < b64.length(); i++) {
        char c = b64[i];
        if (c == '=' || c == '\0') break;
        int v = value(c);
        if (v < 0) return 0;
        buffer = (buffer << 6) | (uint32_t)v;
        bitsCollected += 6;
        if (bitsCollected >= 8) {
            bitsCollected -= 8;
            if (outLen >= outCapacity) return 0;
            out[outLen++] = (uint8_t)((buffer >> bitsCollected) & 0xFF);
        }
    }
    return outLen;
}

inline int esp32RandomForMbedtls(void* /*ctx*/, unsigned char* buf, size_t len) {
    esp_fill_random(buf, len);
    return 0;
}

/**
 * HKDF-SHA256 (RFC 5869), hand-rolled from mbedtls_md's HMAC primitive
 * (already linked in for computeDeviceSignature() above) rather than calling
 * mbedtls_hkdf() directly: this project's ESP32 Arduino core ships mbedtls
 * with MBEDTLS_HKDF_C compiled out (the header declares mbedtls_hkdf(), but
 * linking against it fails with "undefined reference" — confirmed via a real
 * `pio run` build, not assumed), even though the lower-level HMAC/ECP/ECDH/
 * GCM modules this same feature needs are all present. Matches
 * worker/src/client/crypto.ts's hkdfDeriveAesKey() exactly (empty salt,
 * meaning a zeroed HashLen-byte salt per RFC 5869 §2.2) — verified against
 * real WebCrypto HKDF output before being written here.
 */
inline void hkdfSha256(const uint8_t* ikm, size_t ikmLen, const uint8_t* info, size_t infoLen,
                        uint8_t* okm, size_t okmLen) {
    const mbedtls_md_info_t* mdInfo = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    uint8_t zeroSalt[32] = {0};
    uint8_t prk[32];

    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, mdInfo, 1);
    mbedtls_md_hmac_starts(&ctx, zeroSalt, sizeof(zeroSalt));
    mbedtls_md_hmac_update(&ctx, ikm, ikmLen);
    mbedtls_md_hmac_finish(&ctx, prk);
    mbedtls_md_free(&ctx);

    uint8_t t[32];
    size_t tLen = 0;
    size_t generated = 0;
    uint8_t counter = 1;
    while (generated < okmLen) {
        mbedtls_md_init(&ctx);
        mbedtls_md_setup(&ctx, mdInfo, 1);
        mbedtls_md_hmac_starts(&ctx, prk, sizeof(prk));
        mbedtls_md_hmac_update(&ctx, t, tLen);
        mbedtls_md_hmac_update(&ctx, info, infoLen);
        mbedtls_md_hmac_update(&ctx, &counter, 1);
        mbedtls_md_hmac_finish(&ctx, t);
        mbedtls_md_free(&ctx);
        tLen = sizeof(t);

        size_t n = okmLen - generated < sizeof(t) ? okmLen - generated : sizeof(t);
        memcpy(okm + generated, t, n);
        generated += n;
        counter++;
    }
}

/**
 * Generates this device's P-256 keypair on first boot and persists it (see
 * ConfigManager::setSharingKeyPair()) — a no-op on every later boot. The
 * public half is later sent to the Worker via addCommonHeaders()'
 * X-Device-Sharing-Public-Key, the same self-reported-on-every-request
 * pattern as X-Device-Board; the private half never leaves this device.
 *
 * The private key's raw byte length is sized dynamically via
 * mbedtls_mpi_size() rather than assumed to be 32 — real mbedtls represents
 * a P-256 scalar in exactly 32 bytes, but the macOS simulator's stub (see
 * firmware/simulator/stubs/mbedtls/ecp.h) needs more, and this code has to
 * work unmodified against both.
 */
inline void ensureSharingKeyPair(ConfigManager& configManager) {
    if (configManager.hasSharingKeyPair()) return;

    mbedtls_ecp_group grp;
    mbedtls_ecp_group_init(&grp);
    if (mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) != 0) {
        Serial.println("ensureSharingKeyPair: group_load failed");
        mbedtls_ecp_group_free(&grp);
        return;
    }

    mbedtls_mpi d;
    mbedtls_ecp_point Q;
    mbedtls_mpi_init(&d);
    mbedtls_ecp_point_init(&Q);

    int rc = mbedtls_ecp_gen_keypair(&grp, &d, &Q, esp32RandomForMbedtls, nullptr);
    if (rc == 0) {
        size_t privLen = mbedtls_mpi_size(&d);
        uint8_t privBuf[128];  // comfortably covers a real 32-byte scalar or the simulator's 97-byte blob
        uint8_t pubBuf[65];
        size_t pubLen = 0;
        if (privLen > sizeof(privBuf) ||
            mbedtls_mpi_write_binary(&d, privBuf, privLen) != 0 ||
            mbedtls_ecp_point_write_binary(&grp, &Q, MBEDTLS_ECP_PF_UNCOMPRESSED, &pubLen, pubBuf, sizeof(pubBuf)) != 0) {
            Serial.println("ensureSharingKeyPair: failed to export generated keypair");
        } else {
            String privHex;
            privHex.reserve(privLen * 2);
            static const char* hexChars = "0123456789abcdef";
            for (size_t i = 0; i < privLen; i++) {
                privHex += hexChars[privBuf[i] >> 4];
                privHex += hexChars[privBuf[i] & 0x0F];
            }
            configManager.setSharingKeyPair(privHex, bytesToBase64(pubBuf, pubLen));
            Serial.println("ensureSharingKeyPair: generated new P-256 sharing keypair");
        }
    } else {
        Serial.printf("ensureSharingKeyPair: gen_keypair failed (%d)\n", rc);
    }

    mbedtls_mpi_free(&d);
    mbedtls_ecp_point_free(&Q);
    mbedtls_ecp_group_free(&grp);
}

/**
 * ECDH(our sharing private key, ephemeralPub) -> HKDF-SHA256(info) ->
 * AES-256-GCM key -> decrypts `ciphertextB64` (plaintext || 16-byte tag,
 * matching WebCrypto's AES-GCM output layout) into `outKey`. Mirrors
 * worker/src/client/crypto.ts's unwrapKeyWith() exactly, including the HKDF
 * info string, which must match byte-for-byte or the tag check (rightly)
 * fails closed. Returns false on any parse/crypto failure, leaving `outKey`
 * untouched — a bucket this device can't unwrap the key for just doesn't get
 * added to run.bucketKeys, so images from it fail closed too (see
 * fetchAndDisplayImage()'s bucket-key lookup).
 */
inline bool unwrapBucketKey(ConfigManager& configManager, const String& ephemeralPubB64,
                             const String& nonceB64, const String& ciphertextB64,
                             uint8_t outKey[BUCKET_KEY_BYTES]) {
    static const char* HKDF_INFO_BUCKET_WRAP = "eink-bucket-wrap-v1";

    uint8_t ephemeralPub[65];
    uint8_t nonce[12];
    uint8_t ciphertext[BUCKET_KEY_BYTES + 16];
    if (base64Decode(ephemeralPubB64, ephemeralPub, sizeof(ephemeralPub)) != sizeof(ephemeralPub)) return false;
    if (base64Decode(nonceB64, nonce, sizeof(nonce)) != sizeof(nonce)) return false;
    if (base64Decode(ciphertextB64, ciphertext, sizeof(ciphertext)) != sizeof(ciphertext)) return false;

    String privHex = configManager.getSharingPrivateKeyHex();
    if (privHex.length() == 0 || privHex.length() % 2 != 0) return false;
    size_t privLen = privHex.length() / 2;
    uint8_t privBuf[128];
    if (privLen > sizeof(privBuf)) return false;
    hexToBytes(privHex, privBuf, privLen);

    mbedtls_ecp_group grp;
    mbedtls_mpi d, z;
    mbedtls_ecp_point ephemeralQ;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_mpi_init(&z);
    mbedtls_ecp_point_init(&ephemeralQ);

    bool ok = false;
    if (mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
        mbedtls_mpi_read_binary(&d, privBuf, privLen) == 0 &&
        mbedtls_ecp_point_read_binary(&grp, &ephemeralQ, ephemeralPub, sizeof(ephemeralPub)) == 0 &&
        mbedtls_ecdh_compute_shared(&grp, &z, &ephemeralQ, &d, esp32RandomForMbedtls, nullptr) == 0 &&
        mbedtls_mpi_size(&z) == BUCKET_KEY_BYTES) {
        uint8_t sharedSecret[BUCKET_KEY_BYTES];
        mbedtls_mpi_write_binary(&z, sharedSecret, sizeof(sharedSecret));

        uint8_t kek[32];
        hkdfSha256(sharedSecret, sizeof(sharedSecret), reinterpret_cast<const uint8_t*>(HKDF_INFO_BUCKET_WRAP),
                   strlen(HKDF_INFO_BUCKET_WRAP), kek, sizeof(kek));

        mbedtls_gcm_context gcmCtx;
        mbedtls_gcm_init(&gcmCtx);
        if (mbedtls_gcm_setkey(&gcmCtx, MBEDTLS_CIPHER_ID_AES, kek, 256) == 0 &&
            mbedtls_gcm_auth_decrypt(&gcmCtx, BUCKET_KEY_BYTES, nonce, sizeof(nonce), nullptr, 0,
                                      ciphertext + BUCKET_KEY_BYTES, 16, ciphertext, outKey) == 0) {
            ok = true;
        }
        mbedtls_gcm_free(&gcmCtx);
    }

    mbedtls_mpi_free(&d);
    mbedtls_mpi_free(&z);
    mbedtls_ecp_point_free(&ephemeralQ);
    mbedtls_ecp_group_free(&grp);
    return ok;
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

    // Self-reported every request, same pattern as X-Device-Board — see
    // ensureSharingKeyPair()'s docs. Empty only if key generation itself
    // failed (logged there); never blocks the request.
    String sharingPublicKey = configManager.getSharingPublicKeyBase64();
    if (sharingPublicKey.length() > 0) {
        http.addHeader("X-Device-Sharing-Public-Key", sharingPublicKey);
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

    // Unwrap every bucket key this device has been assigned, fresh each wake
    // (see RunState::bucketKeys' comment). A bucket key this device can't
    // unwrap (stale wrap from a since-regenerated keypair, corrupt data) is
    // just skipped, not fatal — fetchAndDisplayImage() fails closed for any
    // image from that specific bucket, same as if it weren't assigned at all.
    run.bucketKeyCount = 0;
    if (doc["bucket_keys"].is<JsonArray>()) {
        for (JsonObject entry : doc["bucket_keys"].as<JsonArray>()) {
            if (run.bucketKeyCount >= MAX_BUCKET_KEYS) {
                Serial.println("Warning: more bucket_keys than MAX_BUCKET_KEYS - ignoring the rest");
                break;
            }
            const char* bucketId = entry["bucket_id"] | "";
            int keyVersion = entry["key_version"] | 1;
            String ephemeralPub = entry["ephemeral_pub"] | "";
            String nonce = entry["nonce"] | "";
            String ciphertext = entry["ciphertext"] | "";
            if (!bucketId[0] || !ephemeralPub.length() || !nonce.length() || !ciphertext.length()) continue;

            BucketKey& slot = run.bucketKeys[run.bucketKeyCount];
            if (unwrapBucketKey(configManager, ephemeralPub, nonce, ciphertext, slot.key)) {
                slot.bucketId = bucketId;
                slot.keyVersion = keyVersion;
                run.bucketKeyCount++;
            } else {
                Serial.printf("Failed to unwrap bucket key for bucket %s (version %d) - images from it will fail to decrypt\n",
                              bucketId, keyVersion);
            }
        }
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

/** Reads exactly `len` bytes from `stream` into `buf`, same
 *  connected/stall-timeout convention the rest of this file uses. Returns
 *  false (having read a possibly-partial amount) on disconnect/stall. */
inline bool readExactlyFromStream(WiFiClient* stream, HTTPClient& http, uint8_t* buf, size_t len, uint32_t stallTimeoutMs) {
    size_t bytesRead = 0;
    uint32_t lastDataTime = millis();
    while (bytesRead < len && http.connected()) {
        size_t available = stream->available();
        if (available > 0) {
            size_t toRead = min(available, len - bytesRead);
            size_t n = stream->readBytes(buf + bytesRead, toRead);
            bytesRead += n;
            lastDataTime = millis();
        }
        yield();
        if (millis() - lastDataTime > stallTimeoutMs) break;
    }
    return bytesRead == len;
}

// Ciphertext is pulled off the network and through mbedtls_gcm_update() this
// many bytes at a time - must be a multiple of 16 (the AES block size), since
// mbedtls_gcm_update() requires every call except the last before
// mbedtls_gcm_finish() to be block-aligned. Deliberately small and fixed
// (not scaled to the image buffer): this is the whole point of the streaming
// approach over the old decrypt-into-a-second-buffer-then-inflate shape -
// EE04 (no PSRAM, ~320KB internal SRAM) can afford two of these on the stack
// but not a second full 384-960KB buffer alongside the display's own.
#define GCM_INFLATE_CHUNK_SIZE 512

/**
 * Streams `cipherLen` bytes of AES-256-GCM ciphertext through `readExact`
 * (must fill the given buffer with exactly the requested byte count, or
 * return false) GCM_INFLATE_CHUNK_SIZE bytes at a time, decrypting each chunk
 * via the streaming mbedtls_gcm_update() (never mbedtls_gcm_auth_decrypt(),
 * which needs the whole ciphertext contiguously in one buffer) into a small
 * scratch buffer, then either copies it (`inflateIt` false - packed_encoding
 * "identity") or DEFLATE-raw-inflates it (`inflateIt` true - "deflate-raw",
 * via tinfl_decompress() with TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF, so
 * `outBuf` itself serves as the inflate window with no second allocation)
 * straight into `outBuf`.
 *
 * `gcmCtx` must already have had mbedtls_gcm_starts(MBEDTLS_GCM_DECRYPT, ...)
 * called on it, and the caller must call mbedtls_gcm_finish() and compare its
 * output against the stream's trailing 16-byte tag BEFORE trusting anything
 * written to `outBuf` or calling display.refresh() - this function only
 * moves/transforms bytes, it never itself checks authenticity (the tag isn't
 * even available until every ciphertext byte has passed through
 * mbedtls_gcm_update(), i.e. until after this function returns).
 *
 * Returns false on any failure (read/stall, GCM error, malformed or
 * oversized-for-outBuf deflate stream) - having possibly already written
 * partial/not-yet-authenticated bytes into outBuf, same "leave it
 * undisplayed, retry next wake" contract every other failure path in
 * fetchAndDisplayImage() already uses.
 *
 * sizeof(tinfl_decompressor) is ~11KB (mostly its three Huffman fast-lookup
 * tables) - real measurement, not a guess: a first version of this function
 * declared it as an ordinary local variable, which built fine (PlatformIO's
 * reported RAM usage only counts .data/.bss, not stack) but would have blown
 * clean through the Arduino-ESP32 core's entire 8192-byte default loop-task
 * stack (CONFIG_ARDUINO_LOOP_STACK_SIZE) on its own, before even accounting
 * for HTTPClient/WiFiClientSecure/TLS's own stack usage in the same call
 * chain - caught by actually computing sizeof() and checking the default
 * stack size, not assumed safe from "the build succeeded." `static` moves it
 * off the stack into .bss instead (a fixed, one-time RAM cost, visible in
 * PlatformIO's own size report), which is safe here specifically because
 * this function is never reentrant or called concurrently - one FreeRTOS
 * task (the Arduino loop task), one call per wake, always run to completion
 * (return or fall through) before the next call.
 */
template <typename ReadExactFn>
inline bool decryptChunksInflate(mbedtls_gcm_context& gcmCtx, size_t cipherLen, bool inflateIt, ReadExactFn readExact,
                                  uint8_t* outBuf, size_t outCapacity, size_t& outWritten) {
    uint8_t cipherChunk[GCM_INFLATE_CHUNK_SIZE];
    uint8_t plainChunk[GCM_INFLATE_CHUNK_SIZE];
    static tinfl_decompressor inflator;
    if (inflateIt) tinfl_init(&inflator);
    size_t remaining = cipherLen;
    outWritten = 0;

    while (remaining > 0) {
        size_t n = remaining < GCM_INFLATE_CHUNK_SIZE ? remaining : GCM_INFLATE_CHUNK_SIZE;
        if (!readExact(cipherChunk, n)) return false;
        if (mbedtls_gcm_update(&gcmCtx, n, cipherChunk, plainChunk) != 0) return false;
        remaining -= n;

        if (!inflateIt) {
            if (outWritten + n > outCapacity) return false;
            memcpy(outBuf + outWritten, plainChunk, n);
            outWritten += n;
            continue;
        }

        size_t inOfs = 0;
        while (inOfs < n) {
            size_t inSize = n - inOfs;
            size_t outSize = outCapacity - outWritten;
            // HAS_MORE_INPUT reflects whether more CIPHERTEXT chunks remain overall
            // (not just more of this already-decrypted chunk) - tinfl only needs to
            // know whether asking for another byte could ever succeed.
            uint32_t flags = (uint32_t)TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF |
                              (remaining > 0 ? (uint32_t)TINFL_FLAG_HAS_MORE_INPUT : 0);
            tinfl_status st = tinfl_decompress(&inflator, plainChunk + inOfs, &inSize, outBuf,
                                                outBuf + outWritten, &outSize, flags);
            inOfs += inSize;
            outWritten += outSize;

            if (st == TINFL_STATUS_DONE) return remaining == 0;
            if (st < 0) return false;  // TINFL_STATUS_FAILED*/BAD_PARAM/ADLER32_MISMATCH
            if (st == TINFL_STATUS_HAS_MORE_OUTPUT) return false;  // would overflow outBuf - reject
            if (st == TINFL_STATUS_NEEDS_MORE_INPUT) {
                if (inOfs < n) return false;  // shouldn't happen: see tinfl's own contract
                break;                        // go read the next ciphertext chunk
            }
            // else: loop again with whatever's left of this already-decrypted chunk
        }
    }
    return true;
}

/**
 * Fetches the pending image, folding the old separate hash pre-check into this
 * same request via ?known_hash= (see worker/src/routes/image-packed.ts). A 304
 * means the server confirmed the image is unchanged; the display buffer is only
 * allocated and display.begin() only called once we know we actually have bytes
 * to show.
 *
 * The response body is AES-256-GCM ciphertext (12-byte nonce || ciphertext ||
 * 16-byte tag — see root CLAUDE.md's encrypted-buckets plan) of either the
 * plain packed 4bpp buffer ("identity") or that buffer DEFLATE-raw-compressed
 * ("deflate-raw" - see packed-blob compression in the same plan section),
 * selected by the X-Packed-Encoding response header.
 *
 * For "identity", Content-Length is exactly display.getBufferSize() + 28, and
 * the ciphertext is streamed directly into the display's own buffer (decrypted
 * in place afterward via one-shot mbedtls_gcm_auth_decrypt() - AES-GCM's
 * CTR-mode keystream XOR is safe to apply in place) exactly as before this
 * feature existed - zero extra allocation, only the 12-byte nonce and 16-byte
 * tag need their own (trivial, stack) buffers.
 *
 * For "deflate-raw", the compressed ciphertext's length isn't known ahead of
 * time (it varies per image) and can't be validated with an exact match, only
 * a sane upper bound (it must be smaller than the uncompressed buffer, or
 * compression wouldn't have been worth shipping - see client/compress.ts).
 * It's decrypted+inflated in small fixed-size chunks (decryptChunksInflate()
 * above, via mbedtls's streaming GCM API) straight into the display buffer,
 * since a second full-size buffer to hold ciphertext contiguously wouldn't
 * fit on a PSRAM-less board (EE04).
 *
 * Either way, the GCM tag is fully verified (mbedtls_gcm_auth_decrypt()'s
 * return code for "identity"; a manual compare against mbedtls_gcm_finish()'s
 * output for "deflate-raw", since the streaming API can't produce a tag until
 * every ciphertext byte has passed through) before display.refresh() is ever
 * called: on a mismatch, the buffer may hold not-yet-authenticated (and, for
 * "deflate-raw", not even fully inflated) bytes, so this returns FAILED
 * without presenting them, same as an incomplete download today.
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
    String responseBucketId = http.header("X-Bucket-Id");
    // Absent (older server) means version 1 - the only version that existed
    // before bucket-key rotation (migrations/0016) did. A device mid-rotation
    // can hold two wraps for the SAME bucketId (old and new key_version), so
    // this header is what disambiguates which one decrypts THIS image.
    int responseKeyVersion = http.header("X-Bucket-Key-Version").length() > 0
        ? http.header("X-Bucket-Key-Version").toInt()
        : 1;
    // Absent (older server, or the unregistered-device QR-registration
    // response) means "identity" - the only encoding that existed before this
    // header did.
    String responsePackedEncoding = http.header("X-Packed-Encoding");
    bool useDeflate = responsePackedEncoding == "deflate-raw";
    // The unregistered-device "scan to register" QR screen (qr-registration.ts)
    // is plaintext, exact-buffer-size bytes - there's no bucket key to encrypt
    // it under for a device nobody has claimed yet. X-Device-ID: default is
    // the same sentinel resolveDeviceKey()/DEFAULT_DEVICE_KEY use server-side
    // for this exact case, so it's what distinguishes "no GCM envelope, skip
    // the bucket-key requirement entirely" from every other (encrypted)
    // response below.
    bool isRegistrationImage = responseDeviceId == "default";
    if (responseImageName.length() > 0 || responseImageHash.length() > 0 || responseDeviceId.length() > 0) {
        Serial.printf("Response headers: X-Image-Name=%s, X-Image-Hash=%s, X-Device-ID=%s, X-Bucket-Id=%s, X-Bucket-Key-Version=%d, X-Packed-Encoding=%s\n",
                      responseImageName.length() > 0 ? responseImageName.c_str() : "(none)",
                      responseImageHash.length() > 0 ? responseImageHash.c_str() : "(none)",
                      responseDeviceId.length() > 0 ? responseDeviceId.c_str() : "(none)",
                      responseBucketId.length() > 0 ? responseBucketId.c_str() : "(none)",
                      responseKeyVersion,
                      responsePackedEncoding.length() > 0 ? responsePackedEncoding.c_str() : "(none)");
    }

    const uint8_t* bucketKey = nullptr;
    if (!isRegistrationImage) {
        for (int i = 0; i < run.bucketKeyCount; i++) {
            if (responseBucketId == run.bucketKeys[i].bucketId && responseKeyVersion == run.bucketKeys[i].keyVersion) {
                bucketKey = run.bucketKeys[i].key;
                break;
            }
        }
        if (!bucketKey) {
            Serial.printf("No unwrapped key for bucket %s at version %d - can't decrypt this image (see syncRemoteConfigAndTime's log)\n",
                          responseBucketId.c_str(), responseKeyVersion);
            http.end();
            return ImageFetchResult::FAILED;
        }
    }

    int contentLength = http.getSize();
    int cipherLen = contentLength - 12 /* nonce */ - 16 /* tag */;
    bool contentLengthOk;
    if (isRegistrationImage) {
        // No nonce/tag envelope on this one - the body is the raw packed
        // buffer, exactly bufferSize bytes.
        contentLengthOk = contentLength == (int)display.getBufferSize();
    } else if (useDeflate) {
        // Compressed length varies per image and isn't known ahead of time -
        // only a sane upper bound is checkable: it must be positive, and
        // smaller than the uncompressed buffer (client/compress.ts only ever
        // ships "deflate-raw" when it measured a meaningful size reduction -
        // see PACKED_COMPRESSION_MIN_SAVINGS_FRACTION - so a compressed body
        // that isn't actually smaller indicates a corrupt/malicious response).
        contentLengthOk = cipherLen > 0 && (size_t)cipherLen <= display.getBufferSize();
    } else {
        contentLengthOk = cipherLen == (int)display.getBufferSize();
    }
    Serial.printf("Content length: %d bytes (cipher %d, encoding %s)\n", contentLength, cipherLen,
                  useDeflate ? "deflate-raw" : "identity");

    if (!contentLengthOk) {
        Serial.printf("Invalid content length: %d (cipher %d) for encoding %s\n", contentLength, cipherLen,
                      useDeflate ? "deflate-raw" : "identity");
        http.end();
        return ImageFetchResult::FAILED;
    }

    // Stream ciphertext directly into (or, for "deflate-raw", straight through
    // decrypt+inflate into) the display's own buffer rather than a separate
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
    size_t bufferSize = display.getBufferSize();

    WiFiClient* stream = http.getStreamPtr();
    uint32_t startTime = millis();

    uint8_t nonce[12];
    // The registration screen has no nonce/tag envelope at all (see
    // isRegistrationImage above) - nothing to read or set up a GCM key for.
    bool ok = isRegistrationImage || readExactlyFromStream(stream, http, nonce, sizeof(nonce), IMAGE_STALL_TIMEOUT_MS);

    mbedtls_gcm_context gcmCtx;
    mbedtls_gcm_init(&gcmCtx);
    int gcmRc = 0;
    if (!isRegistrationImage) {
        gcmRc = ok ? mbedtls_gcm_setkey(&gcmCtx, MBEDTLS_CIPHER_ID_AES, bucketKey, 256) : -1;
        ok = ok && gcmRc == 0;
    }

    size_t bodyBytesRead = 0;   // "identity"/registration: raw bytes read into imageBuffer
    size_t plaintextWritten = 0;  // "deflate-raw": plaintext bytes decryptChunksInflate() produced
    if (ok && (isRegistrationImage || !useDeflate)) {
        // Unchanged from before this feature existed: read exactly bufferSize
        // bytes straight into imageBuffer - ciphertext to be decrypted in
        // place below, or (isRegistrationImage) already-plaintext bytes.
        uint32_t lastDataTime = millis();
        while (bodyBytesRead < bufferSize && http.connected()) {
            size_t available = stream->available();
            if (available > 0) {
                size_t toRead = min(available, bufferSize - bodyBytesRead);
                size_t n = stream->readBytes(imageBuffer + bodyBytesRead, toRead);
                bodyBytesRead += n;
                lastDataTime = millis();
                if ((bodyBytesRead % 102400) == 0) {
                    Serial.printf("Downloaded: %d / %d bytes\n", bodyBytesRead, bufferSize);
                }
            }
            yield();
            if (millis() - lastDataTime > IMAGE_STALL_TIMEOUT_MS) {
                Serial.printf("Download stalled - no data for %u ms\n", IMAGE_STALL_TIMEOUT_MS);
                break;
            }
        }
        ok = bodyBytesRead == bufferSize;
    } else if (ok) {
        ok = mbedtls_gcm_starts(&gcmCtx, MBEDTLS_GCM_DECRYPT, nonce, sizeof(nonce), nullptr, 0) == 0;
        if (ok) {
            auto readExact = [&](uint8_t* buf, size_t len) {
                return readExactlyFromStream(stream, http, buf, len, IMAGE_STALL_TIMEOUT_MS);
            };
            ok = decryptChunksInflate(gcmCtx, (size_t)cipherLen, /*inflateIt=*/true, readExact, imageBuffer,
                                       bufferSize, plaintextWritten);
            if (ok && plaintextWritten != bufferSize) {
                Serial.printf("Inflated %u bytes, expected exactly %u - rejecting\n", (unsigned)plaintextWritten,
                              (unsigned)bufferSize);
                ok = false;
            }
        }
    }

    uint8_t tag[16];
    if (ok && !isRegistrationImage) ok = readExactlyFromStream(stream, http, tag, sizeof(tag), IMAGE_STALL_TIMEOUT_MS);

    http.end();

    Serial.printf("Downloaded %d bytes in %lu ms\n",
                  isRegistrationImage ? (int)bodyBytesRead
                                      : (int)(sizeof(nonce) + (useDeflate ? (size_t)cipherLen : bodyBytesRead) + sizeof(tag)),
                  millis() - startTime);

    if (!ok) {
        Serial.println("Incomplete/failed download! Display buffer may hold partial/undecrypted or "
                        "not-yet-authenticated bytes - will retry next wake since lastImageHash is left unset below.");
        mbedtls_gcm_free(&gcmCtx);
        // display.begin() above already powered the panel on - power it back
        // down without drawing anything, or it stays powered (and draining
        // battery) for the whole sleep interval on a board with no
        // PIN_POWER rail-cut (e.g. EE04).
        display.sleep();
        return ImageFetchResult::FAILED;
    }

    if (isRegistrationImage) {
        // Already plaintext - imageBuffer holds the real bytes as downloaded,
        // nothing to authenticate or decrypt.
    } else if (!useDeflate) {
        // Decrypts imageBuffer in place (safe: AES-GCM's CTR-mode keystream XOR
        // doesn't need input/output to differ) only once the tag has verified -
        // never trust/present ciphertext-shaped bytes as if they were the real
        // plaintext.
        gcmRc = mbedtls_gcm_auth_decrypt(&gcmCtx, bufferSize, nonce, sizeof(nonce), nullptr, 0, tag, sizeof(tag),
                                          imageBuffer, imageBuffer);
    } else {
        // The streaming API can't produce a tag until every ciphertext byte has
        // passed through mbedtls_gcm_update() (already done above, inside
        // decryptChunksInflate()) - compare it ourselves rather than trusting
        // whatever tinfl already wrote into imageBuffer.
        uint8_t computedTag[16];
        gcmRc = mbedtls_gcm_finish(&gcmCtx, computedTag, sizeof(computedTag));
        if (gcmRc == 0) {
            uint8_t diff = 0;
            for (int i = 0; i < 16; i++) diff |= (uint8_t)(computedTag[i] ^ tag[i]);
            if (diff != 0) gcmRc = MBEDTLS_ERR_GCM_AUTH_FAILED;
        }
    }
    mbedtls_gcm_free(&gcmCtx);
    if (gcmRc != 0) {
        Serial.printf("Image decryption/authentication failed (%d) - not displaying, will retry next wake\n", gcmRc);
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
