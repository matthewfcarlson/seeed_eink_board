#ifndef OTA_HEALTH_H
#define OTA_HEALTH_H

#include <Arduino.h>
#include <Preferences.h>

/**
 * OTA rollback safety net + crash reporting.
 *
 * Both the automatic ESP-IDF app-rollback mechanism (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE)
 * and core-dump-to-flash (CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH, ELF format) are already
 * compiled into the stock Arduino-ESP32 core for esp32s3, and this board's own default
 * partition table (default_8MB.csv) already reserves a 64KB `coredump` partition — none
 * of that needed changing. This class is the application-level half:
 *
 *  - Bootloader rollback only protects against a boot-time crash/panic on the pending
 *    (freshly-flashed) partition: if it resets before the app confirms itself, the
 *    *next* boot's bootloader sees the still-pending state and switches back to the
 *    previous partition on its own, before any app code runs. That's automatic and
 *    needs no help from us except eventually calling esp_ota_mark_app_valid_cancel_rollback()
 *    once we're confident (else the device is stuck unable to accept another OTA).
 *  - It does NOT protect against firmware that boots fine but never manages to prove
 *    itself (e.g. a WiFi/HTTP regression that leaves it always failing to reach the
 *    server). That's this class's NVS-tracked boot-attempt counter: after
 *    OTA_MAX_UNCONFIRMED_BOOT_ATTEMPTS wake cycles without confirmHealthy() being
 *    called, we force a rollback ourselves via esp_ota_mark_app_invalid_rollback_and_reboot().
 *  - Whenever either path fires, or a core dump is sitting in flash from an unrelated
 *    crash (not just an OTA one), a compact JSON report (reset reason, backtrace PCs,
 *    etc.) is queued in NVS for main.cpp to upload to POST /crash_report once it has
 *    connectivity — see sendCrashReportIfPending() in main.cpp.
 */
#define OTA_MAX_UNCONFIRMED_BOOT_ATTEMPTS 3

class OtaHealth {
public:
    // Loads persisted state from NVS. Call once, early in setup().
    void begin();

    // Call right after a successful OTA flash, before rebooting into it — records
    // what we're attempting so the next boot(s) can tell whether it stuck.
    void recordOtaAttempt(const String& fromVersion, const String& toVersion);

    // Call as early as possible in setup(), before anything that could itself crash.
    // Detects a completed rollback (bootloader- or self-triggered), captures crash
    // diagnostics, and forces a rollback if the pending version has failed to confirm
    // itself too many times. May not return (calls esp_restart() internally) in that
    // last case.
    void checkBootHealth();

    // Call once this boot has proven the running firmware works (e.g. a successful
    // authenticated round trip to the server). No-op if no OTA is pending confirmation.
    void confirmHealthy();

    // A crash/rollback report is queued and ready to upload.
    bool hasPendingReport() const;
    String getPendingReportJson() const;
    // Call after a successful upload — clears the queued report and erases the
    // on-flash core dump so it isn't re-reported on a future boot.
    void clearPendingReport();

private:
    Preferences prefs_;
    String pendingVersion_;   // version we OTA'd to but haven't confirmed yet ("" = none pending)
    String previousVersion_;  // version we OTA'd from, for detecting a completed rollback
    uint32_t bootAttempts_ = 0;
    bool hasPendingReport_ = false;
    String pendingReportJson_;

    void loadFromNVS();
    void savePendingOta();
    void clearPendingOta();
    void saveReport(const String& json);

    // Builds the JSON crash report (reset reason + core dump summary, if any) and
    // persists it to NVS. `rolledBack` / `failedVersion` describe an OTA that just
    // reverted; pass rolledBack=false, failedVersion="" for a plain (non-OTA) crash.
    void buildAndQueueReport(bool rolledBack, const String& failedVersion);
};

#endif // OTA_HEALTH_H
