#include "ota_health.h"
#include "version.h"
#include <ArduinoJson.h>
#include <esp_system.h>
#include <esp_ota_ops.h>
#include <esp_core_dump.h>

static const char* NVS_NAMESPACE = "ota_health";
static const char* KEY_PEND_VER = "pend_ver";
static const char* KEY_PREV_VER = "prev_ver";
static const char* KEY_ATTEMPTS = "attempts";
static const char* KEY_REPORT = "report";

static const char* resetReasonToString(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON:   return "poweron";
        case ESP_RST_EXT:       return "ext";
        case ESP_RST_SW:        return "sw";
        case ESP_RST_PANIC:     return "panic";
        case ESP_RST_INT_WDT:   return "int_wdt";
        case ESP_RST_TASK_WDT:  return "task_wdt";
        case ESP_RST_WDT:       return "wdt";
        case ESP_RST_DEEPSLEEP: return "deepsleep";
        case ESP_RST_BROWNOUT:  return "brownout";
        case ESP_RST_SDIO:      return "sdio";
        default:                 return "unknown";
    }
}

void OtaHealth::begin() {
    loadFromNVS();
    if (pendingVersion_.length() > 0) {
        Serial.printf("OtaHealth: OTA to %s pending confirmation (from %s, %u attempt(s) so far)\n",
                      pendingVersion_.c_str(), previousVersion_.c_str(), bootAttempts_);
    }
    if (hasPendingReport_) {
        Serial.println("OtaHealth: a crash/rollback report is queued for upload");
    }
}

void OtaHealth::loadFromNVS() {
    prefs_.begin(NVS_NAMESPACE, true);  // read-only
    pendingVersion_ = prefs_.getString(KEY_PEND_VER, "");
    previousVersion_ = prefs_.getString(KEY_PREV_VER, "");
    bootAttempts_ = prefs_.getUInt(KEY_ATTEMPTS, 0);
    pendingReportJson_ = prefs_.getString(KEY_REPORT, "");
    hasPendingReport_ = pendingReportJson_.length() > 0;
    prefs_.end();
}

void OtaHealth::savePendingOta() {
    prefs_.begin(NVS_NAMESPACE, false);
    prefs_.putString(KEY_PEND_VER, pendingVersion_);
    prefs_.putString(KEY_PREV_VER, previousVersion_);
    prefs_.putUInt(KEY_ATTEMPTS, bootAttempts_);
    prefs_.end();
}

void OtaHealth::clearPendingOta() {
    pendingVersion_ = "";
    previousVersion_ = "";
    bootAttempts_ = 0;
    prefs_.begin(NVS_NAMESPACE, false);
    prefs_.remove(KEY_PEND_VER);
    prefs_.remove(KEY_PREV_VER);
    prefs_.remove(KEY_ATTEMPTS);
    prefs_.end();
}

void OtaHealth::saveReport(const String& json) {
    pendingReportJson_ = json;
    hasPendingReport_ = true;
    prefs_.begin(NVS_NAMESPACE, false);
    prefs_.putString(KEY_REPORT, json);
    prefs_.end();
    Serial.printf("OtaHealth: queued crash report (%u bytes): %s\n", json.length(), json.c_str());
}

void OtaHealth::recordOtaAttempt(const String& fromVersion, const String& toVersion) {
    pendingVersion_ = toVersion;
    previousVersion_ = fromVersion;
    bootAttempts_ = 0;
    savePendingOta();
}

void OtaHealth::buildAndQueueReport(bool rolledBack, const String& failedVersion) {
    JsonDocument doc;
    doc["firmware_version"] = rolledBack ? failedVersion : String(FIRMWARE_VERSION);
    doc["rolled_back"] = rolledBack;
    doc["boot_attempts"] = bootAttempts_;
    doc["reset_reason"] = resetReasonToString(esp_reset_reason());

    // Guarded rather than assumed: platformio.ini doesn't pin the espressif32 platform
    // version, so a future toolchain update could in principle ship different sdkconfig
    // defaults. Everything still compiles (just without backtrace fields) if coredump
    // support ever isn't there - see ota_health.h's header comment for what's currently
    // shipped by default for this board.
#if CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH && CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF
    esp_core_dump_summary_t* summary = (esp_core_dump_summary_t*)malloc(sizeof(esp_core_dump_summary_t));
    if (summary != nullptr) {
        if (esp_core_dump_get_summary(summary) == ESP_OK) {
            char taskName[sizeof(summary->exc_task) + 1] = {0};
            strncpy(taskName, summary->exc_task, sizeof(summary->exc_task));
            doc["crash_task"] = taskName;

            char pcHex[11];
            snprintf(pcHex, sizeof(pcHex), "0x%08x", (unsigned)summary->exc_pc);
            doc["crash_pc"] = pcHex;
            doc["crash_cause"] = summary->ex_info.exc_cause;
            doc["backtrace_corrupted"] = summary->exc_bt_info.corrupted;

            JsonArray bt = doc["backtrace"].to<JsonArray>();
            uint32_t depth = summary->exc_bt_info.depth;
            if (depth > 16) depth = 16;
            for (uint32_t i = 0; i < depth; i++) {
                char addr[11];
                snprintf(addr, sizeof(addr), "0x%08x", (unsigned)summary->exc_bt_info.bt[i]);
                bt.add(String(addr));
            }
        }
        free(summary);
    }
#endif

    String json;
    serializeJson(doc, json);
    saveReport(json);
}

void OtaHealth::checkBootHealth() {
    esp_reset_reason_t reason = esp_reset_reason();
    bool crashyReset = (reason == ESP_RST_PANIC || reason == ESP_RST_INT_WDT ||
                         reason == ESP_RST_TASK_WDT || reason == ESP_RST_WDT ||
                         reason == ESP_RST_BROWNOUT);
    bool coredumpPresent = (esp_core_dump_image_check() == ESP_OK);

    String currentVersion = FIRMWARE_VERSION;
    // We flashed `pendingVersion_` but are now back on `previousVersion_` without ever
    // confirming the new one - either the bootloader auto-rolled-back after a boot-time
    // crash, or a previous cycle force-rolled-back via mark_app_invalid_rollback_and_reboot()
    // below and this is that reboot landing.
    bool rolledBack = pendingVersion_.length() > 0 &&
                       pendingVersion_ != currentVersion &&
                       previousVersion_ == currentVersion;
    bool isPendingVersion = pendingVersion_.length() > 0 && pendingVersion_ == currentVersion;

    if (rolledBack || crashyReset || coredumpPresent) {
        Serial.printf("OtaHealth: flagging boot for crash report (reset=%s, rolled_back=%s, coredump=%s)\n",
                      resetReasonToString(reason), rolledBack ? "yes" : "no", coredumpPresent ? "yes" : "no");
        buildAndQueueReport(rolledBack, rolledBack ? pendingVersion_ : "");
    }

    if (rolledBack) {
        Serial.printf("OtaHealth: %s was rolled back to %s\n", pendingVersion_.c_str(), currentVersion.c_str());
        clearPendingOta();
        return;
    }

    if (isPendingVersion) {
        bootAttempts_++;
        savePendingOta();
        Serial.printf("OtaHealth: unconfirmed OTA boot %u/%u on version %s\n",
                      bootAttempts_, OTA_MAX_UNCONFIRMED_BOOT_ATTEMPTS, currentVersion.c_str());

        if (bootAttempts_ > OTA_MAX_UNCONFIRMED_BOOT_ATTEMPTS) {
            Serial.println("OtaHealth: exceeded max unconfirmed boots - forcing rollback to previous firmware");
            buildAndQueueReport(true, currentVersion);
            clearPendingOta();
            Serial.flush();
            esp_err_t err = esp_ota_mark_app_invalid_rollback_and_reboot();
            // Only reaches here if the rollback couldn't be triggered (e.g. the previous
            // partition isn't valid either) - fall through and keep running this version.
            Serial.printf("OtaHealth: forced rollback call returned %d (expected not to return)\n", err);
        }
    }
}

void OtaHealth::confirmHealthy() {
    if (pendingVersion_.length() == 0) return;
    if (pendingVersion_ != String(FIRMWARE_VERSION)) return;  // inconsistent state - let checkBootHealth resolve it next boot

    esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    Serial.printf("OtaHealth: marked %s valid, rollback cancelled (err=%d)\n", FIRMWARE_VERSION, err);
    clearPendingOta();
}

bool OtaHealth::hasPendingReport() const {
    return hasPendingReport_;
}

String OtaHealth::getPendingReportJson() const {
    return pendingReportJson_;
}

void OtaHealth::clearPendingReport() {
    hasPendingReport_ = false;
    pendingReportJson_ = "";
    prefs_.begin(NVS_NAMESPACE, false);
    prefs_.remove(KEY_REPORT);
    prefs_.end();
#if CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH
    esp_core_dump_image_erase();
#endif
}
