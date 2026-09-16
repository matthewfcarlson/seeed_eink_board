#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include <string>
#include <functional>
#include "RebootSignal.h"

// Adapted from ~/git/epaper_clock/simulator/stubs/Arduino.h (see
// firmware/simulator/README.md for the full rationale). Differences from
// that version: ESP.restart() throws RebootSignal instead of setting a flag
// (see RebootSignal.h), and this adds psramFound()/ps_malloc()/
// setCpuFrequencyMhz()/yield() - all used by our board code, none needed by
// epaper_clock's.

// --- Types ---
typedef bool     boolean;
typedef uint8_t  byte;

// --- Pin constants ---
#define HIGH 1
#define LOW  0
#define INPUT       0
#define OUTPUT      1
#define INPUT_PULLUP 2

typedef int adc_attenuation_t;
#define ADC_11db 3

// RTC data survives deep sleep on ESP32; in the simulator these are plain
// globals (a single process run stands in for "power stays on").
#define RTC_DATA_ATTR

// Flash storage on ESP32 - regular RAM in the simulator
#define PROGMEM
#define pgm_read_byte(addr)  (*(const uint8_t *)(addr))
#define pgm_read_word(addr)  (*(const uint16_t *)(addr))
#define pgm_read_dword(addr) (*(const uint32_t *)(addr))

// --- Timing ---
inline unsigned long millis() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}
inline unsigned long micros() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long)(ts.tv_sec * 1000000 + ts.tv_nsec / 1000);
}
inline void delay(unsigned long ms)      { usleep((useconds_t)(ms * 1000)); }
inline void delayMicroseconds(unsigned int us) { usleep(us); }
inline void yield() {}

// --- GPIO/ADC stubs ---
inline void pinMode(int, int)            {}
inline void digitalWrite(int, int)       {}
// Both boards' display.cpp waitUntilIdle() loop while digitalRead(PIN_BUSY)
// == LOW (their busy-pin polarities differ, but both treat HIGH as "idle" -
// see each board's display.cpp comment on waitUntilIdle()). Always HIGH here
// makes every wait resolve in zero iterations.
inline int  digitalRead(int)             { return HIGH; }
inline int  analogRead(int)              { return 2048; }
inline void analogReadResolution(int)    {}
inline void analogSetPinAttenuation(int, adc_attenuation_t) {}
inline void setCpuFrequencyMhz(int)      {}

// --- PSRAM (ee02's display buffer prefers PSRAM; falls back to malloc()) ---
inline bool psramFound() { return false; }
inline void *ps_malloc(size_t size) { return malloc(size); }

// ESP-IDF's hardware RNG, reached via <esp_random.h> transitively through
// the real Arduino.h - config_manager.cpp's ensureDeviceSecret() uses it to
// generate this device's HMAC secret. arc4random_buf() is libc's
// cryptographically-secure equivalent on macOS.
inline void esp_fill_random(void *buf, size_t len) { arc4random_buf(buf, len); }

// --- String class --- (defined before SerialClass so println can use it)
class String {
public:
    String()                    {}
    String(const char *s)       : s_(s ? s : "") {}
    String(char c)              : s_(1, c) {}
    String(int v)               : s_(std::to_string(v)) {}
    String(long v)              : s_(std::to_string(v)) {}
    String(unsigned int v)      : s_(std::to_string(v)) {}
    String(float v, int d = 2)  { char buf[32]; snprintf(buf,sizeof(buf),"%.*f",d,v); s_=buf; }

    const char *c_str()  const  { return s_.c_str(); }
    // unsigned, not int: matches real Arduino String::length() exactly -
    // ArduinoJson's IsString<T> trait (vendor/ArduinoJson/ArduinoJson/Strings/
    // StringTraits.hpp) specifically requires an unsigned return type here.
    unsigned int length() const { return (unsigned int)s_.size(); }
    bool isEmpty()       const  { return s_.empty(); }
    void reserve(size_t n)      { s_.reserve(n); }
    char charAt(int i) const    { return s_[(size_t)i]; }
    // Used by ArduinoJson's Writer<String> specialization
    // (vendor/ArduinoJson/.../Writers/ArduinoStringWriter.hpp) to append
    // serialized output - matches real Arduino String::concat()'s signature.
    unsigned char concat(const char *cstr) {
        if (!cstr) return 0;
        s_ += cstr;
        return 1;
    }

    int indexOf(const char *sub, int from = 0) const {
        auto p = s_.find(sub, from);
        return p == std::string::npos ? -1 : (int)p;
    }
    int indexOf(char c, int from = 0) const {
        auto p = s_.find(c, from);
        return p == std::string::npos ? -1 : (int)p;
    }
    String substring(int from, int to = -1) const {
        if (to < 0) return String(s_.substr(from).c_str());
        return String(s_.substr(from, to - from).c_str());
    }
    void toUpperCase() { for (auto &c : s_) c = (char)toupper((unsigned char)c); }
    float  toFloat() const { return strtof(s_.c_str(), nullptr); }
    int    toInt()   const { return atoi(s_.c_str()); }
    bool equalsIgnoreCase(const String &o) const {
        return strcasecmp(s_.c_str(), o.s_.c_str()) == 0;
    }

    char &operator[](int i)        { return s_[i]; }
    char  operator[](int i) const  { return s_[i]; }
    String  operator+(const String &o) const { return String((s_ + o.s_).c_str()); }
    String  operator+(const char *o)   const { return String((s_ + o).c_str()); }
    String &operator+=(const String &o) { s_ += o.s_; return *this; }
    String &operator+=(const char *o)   { s_ += o; return *this; }
    String &operator+=(char c)          { s_ += c; return *this; }
    String &operator=(const char *s)   { s_ = s ? s : ""; return *this; }
    String &operator=(const String &o) { s_ = o.s_; return *this; }
    bool operator==(const char *s) const { return s_ == s; }
    bool operator!=(const char *s) const { return s_ != s; }
    bool operator==(const String &o) const { return s_ == o.s_; }
    bool operator!=(const String &o) const { return s_ != o.s_; }

private:
    std::string s_;
};
inline String operator+(const char *a, const String &b) {
    return String((std::string(a) + b.c_str()).c_str());
}

// --- IPAddress ---
struct IPAddress {
    uint8_t bytes[4] = {};
    String toString() const {
        char buf[16];
        snprintf(buf,sizeof(buf),"%d.%d.%d.%d",bytes[0],bytes[1],bytes[2],bytes[3]);
        return String(buf);
    }
};

// --- Serial stub (defined after String so println(const String&) compiles) ---
struct SerialClass {
    void begin(int)  {}
    void flush()     { fflush(stdout); }
    int available()  { return 0; }
    int read()        { return -1; }

    void print(const char *s)     { fputs(s ? s : "", stdout); }
    void print(const String &s)   { fputs(s.c_str(), stdout); }
    void print(int v)             { printf("%d", v); }
    void print(long v)            { printf("%ld", v); }
    void print(float v, int d=2)  { printf("%.*f", d, v); }

    void println()                { putchar('\n'); }
    void println(const char *s)   { puts(s ? s : ""); }
    void println(const String &s) { puts(s.c_str()); }
    void println(int v)           { printf("%d\n", v); }
    void println(long v)          { printf("%ld\n", v); }
    void println(float v, int d=2){ printf("%.*f\n", d, v); }
    template<typename T>
    auto println(const T &v) -> decltype(v.toString(), void()) {
        puts(v.toString().c_str());
    }

    template<typename... Args>
    void printf(const char *fmt, Args... args) { ::printf(fmt, args...); }
};
inline SerialClass Serial;

// --- ESP restart --- (real ESP.restart() never returns; see RebootSignal.h)
struct EspClass {
    [[noreturn]] void restart() { throw RebootSignal{}; }
};
inline EspClass ESP;

// --- Math helpers ---
#ifndef min
#define min(a,b) ((a)<(b)?(a):(b))
#define max(a,b) ((a)>(b)?(a):(b))
#endif
template<typename T> T constrain(T v, T lo, T hi) {
    return v < lo ? lo : v > hi ? hi : v;
}
