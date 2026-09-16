#pragma once
#include "esp_system.h"
#include "RebootSignal.h"

// Real bootloader-rollback semantics don't apply to a single-binary native
// build, so these just report success without touching any partition.
inline esp_err_t esp_ota_mark_app_valid_cancel_rollback() { return ESP_OK; }
// Real esp_ota_mark_app_invalid_rollback_and_reboot() never returns; see
// RebootSignal.h. ota_health.cpp's caller logs if this call itself returns
// (meaning the rollback couldn't be triggered), so throwing here - meaning
// it "always succeeds" - is the more useful native behavior.
[[noreturn]] inline esp_err_t esp_ota_mark_app_invalid_rollback_and_reboot() {
    throw RebootSignal{};
}
