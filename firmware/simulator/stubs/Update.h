#pragma once
#include "Arduino.h"

// Minimal stand-in for ESP32's Update (esp_ota) library. The simulator never
// actually flashes anything - OTA only triggers when a Worker admin
// explicitly targets this simulated device's MAC (see
// worker/src/lib/firmware-target.ts), which won't happen by default, so this
// just needs to compile and fail safely (device_app.h already treats a
// failed OTA as "continue with current firmware this cycle").

#define U_FLASH 0
#define UPDATE_SIZE_UNKNOWN 0xFFFFFFFFUL

struct UpdateClass {
    bool   begin(size_t /*size*/, int /*command*/ = U_FLASH) { return false; }
    size_t write(const uint8_t *, size_t)                     { return 0; }
    bool   end(bool = false)                                  { return false; }
    void   abort()                                            {}
    const char *errorString()                                 { return "sim: firmware update not supported"; }
};
inline UpdateClass Update;
