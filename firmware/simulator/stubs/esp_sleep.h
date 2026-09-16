#pragma once
#include <stdint.h>
#include "RebootSignal.h"

typedef enum {
    ESP_SLEEP_WAKEUP_UNDEFINED = 0,
    ESP_SLEEP_WAKEUP_EXT0,
    ESP_SLEEP_WAKEUP_EXT1,
    ESP_SLEEP_WAKEUP_TIMER,
    ESP_SLEEP_WAKEUP_TOUCHPAD,
    ESP_SLEEP_WAKEUP_ULP,
} esp_sleep_wakeup_cause_t;

#define ESP_EXT1_WAKEUP_ANY_LOW  0
#define ESP_EXT1_WAKEUP_ANY_HIGH 1

// Set by esp_sleep_enable_timer_wakeup(); read by main_native.cpp's driver
// loop after catching RebootSignal to decide how long to pause before the
// next simulated boot cycle. Reset to 0 by the driver before each setup()
// call, so a config-mode/OTA reboot (which never calls this) leaves it 0 -
// meaning "reboot immediately, don't pause" - while a real deep-sleep leaves
// it holding the interval that was actually requested.
extern uint64_t g_sleep_us;

inline void esp_sleep_enable_timer_wakeup(uint64_t us) { g_sleep_us = us; }
inline void esp_sleep_enable_ext1_wakeup(uint64_t, int) {}
inline esp_sleep_wakeup_cause_t esp_sleep_get_wakeup_cause() {
    return ESP_SLEEP_WAKEUP_TIMER;
}
// Real esp_deep_sleep_start() never returns; see RebootSignal.h.
[[noreturn]] inline void esp_deep_sleep_start() {
    throw RebootSignal{};
}
