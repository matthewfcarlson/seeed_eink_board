#pragma once
#include <time.h>
#include <stdlib.h>

// Straight port of epaper_clock's simulator/stubs/time_compat.h. We don't
// currently need a SIM_TIME-style freeze (nothing in our firmware gates
// behavior on time-of-day the way the clock's night-cadence logic does), so
// this only provides configTzTime()/getLocalTime() shims - device_app.h
// itself never calls either (it uses settimeofday()/time() directly, both
// already real libc functions needing no stub).
inline void configTzTime(const char *tz, const char *, const char * = nullptr) {
    setenv("TZ", tz, 1);
    tzset();
}

inline bool getLocalTime(struct tm *info, int /*timeoutMs*/ = 5000) {
    time_t now = time(nullptr);
    struct tm *t = localtime(&now);
    if (!t) return false;
    *info = *t;
    return true;
}
