#pragma once
#include "esp_system.h"

// ota_health.cpp's only unconditional (non-#if-guarded) call into this API is
// esp_core_dump_image_check() - everything else in there (summary retrieval,
// erase) is wrapped in `#if CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH` etc., ESP-IDF
// sdkconfig macros that are simply undefined (so 0) in a native build,
// compiling that code out entirely. No real core dump partition exists here,
// so this always reports "none present."
inline esp_err_t esp_core_dump_image_check() { return 1 /* != ESP_OK */; }
