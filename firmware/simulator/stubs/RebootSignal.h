#pragma once

// Thrown by every native "reboot" stub (esp_deep_sleep_start() in
// esp_sleep.h, ESP.restart() in Arduino.h,
// esp_ota_mark_app_invalid_rollback_and_reboot() in esp_ota_ops.h) instead of
// setting a flag main.cpp would need to poll. Real firmware code never
// returns from any of these either (they genuinely reset the chip), so
// unwinding the C++ call stack out from under whatever loop called them -
// including BLEProvisioning's real `while (true) { bleProvisioning.loop();
// delay(10); }` in main.cpp's runConfigMode(), which doesn't poll any flag -
// is the closest native equivalent. Caught once, in main_native.cpp's outer
// driver loop around setup().
struct RebootSignal {};
