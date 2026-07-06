#ifndef CONFIG_MANAGER_H
#define CONFIG_MANAGER_H

#include <Arduino.h>
#include <Preferences.h>

/**
 * Configuration Manager
 *
 * Handles persistent storage of configuration values in NVS (Non-Volatile Storage).
 * Values persist across reboots and deep sleep cycles.
 *
 * Stored configuration:
 *   - Server host (e.g., "192.168.86.100" or "myserver.example.com")
 *   - Server port (e.g., 5000)
 *   - Whether to use HTTPS (e.g., for a Cloudflare Worker backend) or plain HTTP
 *     (e.g., for a local Flask dev server with no TLS)
 *   - Image endpoint path (e.g., "/image_packed")
 *   - Refresh interval in minutes
 *   - Active window start/end hour (0-23, local time)
 *   - Local timezone offset from UTC in minutes
 */

// Default values (used on first boot or after NVS reset)
#define DEFAULT_SERVER_HOST "eink.matthewc.dev"
#define DEFAULT_SERVER_PORT 443
#define DEFAULT_USE_HTTPS true
#define DEFAULT_IMAGE_ENDPOINT "/image_packed"
#define DEFAULT_SLEEP_MINUTES 60
#define DEFAULT_ACTIVE_START_HOUR 8
#define DEFAULT_ACTIVE_END_HOUR 20
#define DEFAULT_TIMEZONE_OFFSET_MINUTES -360

// Maximum string lengths
#define MAX_HOST_LENGTH 128
#define MAX_ENDPOINT_LENGTH 64

class ConfigManager {
public:
    ConfigManager();

    // Initialize and load config from NVS
    void begin();

    // WiFi credentials (NVS-backed, set via BLE provisioning — see ble_provisioning.h).
    // No compile-time default: an empty SSID means "never provisioned," which
    // main.cpp's setup() treats as "force config mode" rather than attempting to
    // connect. Deliberately NOT touched by OTA firmware updates (NVS is a separate
    // flash partition from the app image) so a firmware update can never disconnect
    // a device from its WiFi network.
    String getWifiSsid();
    String getWifiPassword();
    void setWifiCredentials(const String& ssid, const String& password);

    // Get current configuration
    String getServerHost();
    uint16_t getServerPort();
    bool getUseHttps();
    String getImageEndpoint();
    uint16_t getSleepMinutes();
    uint8_t getActiveStartHour();
    uint8_t getActiveEndHour();
    int16_t getTimezoneOffsetMinutes();

    // Build full URL from components
    String getFullURL();

    // Set configuration (automatically saves to NVS)
    void setServerHost(const String& host);
    void setServerPort(uint16_t port);
    void setUseHttps(bool useHttps);
    void setImageEndpoint(const String& endpoint);
    void setSleepMinutes(uint16_t minutes);
    void setActiveStartHour(uint8_t hour);
    void setActiveEndHour(uint8_t hour);
    void setTimezoneOffsetMinutes(int16_t minutes);

    // Set all at once
    void setConfig(const String& host, uint16_t port, bool useHttps, const String& endpoint,
                   uint16_t sleepMinutes, uint8_t activeStartHour,
                   uint8_t activeEndHour, int16_t timezoneOffsetMinutes);

    // Reset to defaults
    void resetToDefaults();

    // Print current config to Serial
    void printConfig();

    // Per-device HMAC secret (hex string), used to sign requests so a device's
    // mac address alone isn't enough to impersonate it — see main.cpp's
    // computeDeviceSignature() and worker/src/lib/device-signature.ts. Generated
    // once on first boot and persisted; never regenerated automatically.
    String getDeviceSecret();
    void ensureDeviceSecret();

    // Whether the server has confirmed (via device_config's device_id field)
    // that this device is claimed. While false, requests include the raw secret
    // (X-Device-Secret) so the registration QR can be built; once true, the
    // secret itself is never sent again, only signatures derived from it.
    bool getDeviceRegistered();
    void setDeviceRegistered(bool registered);

private:
    Preferences prefs_;
    String wifiSsid_;
    String wifiPassword_;
    String serverHost_;
    uint16_t serverPort_;
    bool useHttps_;
    String imageEndpoint_;
    uint16_t sleepMinutes_;
    uint8_t activeStartHour_;
    uint8_t activeEndHour_;
    int16_t timezoneOffsetMinutes_;
    String deviceSecret_;
    bool deviceRegistered_;

    void loadFromNVS();
    void saveToNVS();
};

#endif // CONFIG_MANAGER_H
