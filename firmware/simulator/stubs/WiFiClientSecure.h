#pragma once
#include "Arduino.h"

// Minimal stand-in for ESP32's WiFiClientSecure. libcurl (see HTTPClient.h)
// handles TLS itself when the URL scheme is https:// - this type only exists
// to satisfy device_app.h's beginRequest()/HTTPClient::begin() call shape.
struct WiFiClientSecure {
    void setInsecure() {}
};
