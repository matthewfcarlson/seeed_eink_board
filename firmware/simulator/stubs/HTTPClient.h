#pragma once
#include "Arduino.h"
#include "WiFiClientSecure.h"
#include <curl/curl.h>
#include <string>
#include <vector>
#include <map>
#include <cstring>

#define HTTP_CODE_OK 200

// Unlike epaper_clock's HTTPClient stub (which fakes every response locally,
// since that project has no live backend), this one makes real HTTP requests
// via libcurl - the simulator needs to actually exercise the Worker's
// device-facing routes against a local `wrangler dev`. Real ESP32 HTTPClient
// streams the response body incrementally as bytes arrive on the wire;
// device_app.h's read loops are written for that shape
// (available()/readBytes()/http.connected()). This buffers the whole
// response synchronously in perform() instead (irrelevant over localhost)
// and exposes it through the same shape via WiFiClient below, so
// device_app.h needs no changes.
struct WiFiClient {
    const std::vector<uint8_t> *body = nullptr;
    size_t pos = 0;

    int available() const {
        if (!body) return 0;
        return (int)(body->size() - pos);
    }
    size_t readBytes(uint8_t *buf, size_t n) {
        if (!body) return 0;
        size_t remaining = body->size() - pos;
        size_t toCopy = n < remaining ? n : remaining;
        memcpy(buf, body->data() + pos, toCopy);
        pos += toCopy;
        return toCopy;
    }
};

class HTTPClient {
public:
    bool begin(const char *url)                    { url_ = url; return true; }
    bool begin(WiFiClientSecure &, const char *url) { return begin(url); }
    bool begin(const String &url)                    { return begin(url.c_str()); }
    bool begin(WiFiClientSecure &c, const String &url) { return begin(c, url.c_str()); }

    void addHeader(const char *name, const char *value) {
        requestHeaders_.push_back(std::string(name) + ": " + value);
    }
    void addHeader(const String &name, const String &value) {
        addHeader(name.c_str(), value.c_str());
    }
    void setTimeout(uint32_t ms) { timeoutMs_ = ms; }

    int GET()                       { return perform("GET", nullptr); }
    int POST(const String &body)    { return perform("POST", &body); }

    int getSize() const { return (int)body_.size(); }
    String getString() const { return String(std::string(body_.begin(), body_.end()).c_str()); }

    String header(const char *name) const {
        auto it = responseHeaders_.find(lower(name));
        return it == responseHeaders_.end() ? String("") : String(it->second.c_str());
    }
    String header(const String &name) const { return header(name.c_str()); }

    // The whole body is already buffered by the time GET()/POST() returns
    // (see perform()), so there's never a mid-transfer "disconnect" to model.
    bool connected() const { return true; }

    WiFiClient *getStreamPtr() {
        stream_.body = &body_;
        stream_.pos = 0;
        return &stream_;
    }

    void end() {}

private:
    std::string url_;
    uint32_t timeoutMs_ = 30000;
    std::vector<std::string> requestHeaders_;
    std::vector<uint8_t> body_;
    std::map<std::string, std::string> responseHeaders_;
    WiFiClient stream_;

    static std::string lower(const char *s) {
        std::string out(s);
        for (auto &c : out) c = (char)tolower((unsigned char)c);
        return out;
    }

    static size_t writeCb(char *ptr, size_t size, size_t nmemb, void *userdata) {
        auto *out = static_cast<std::vector<uint8_t> *>(userdata);
        size_t n = size * nmemb;
        out->insert(out->end(), ptr, ptr + n);
        return n;
    }

    static size_t headerCb(char *buf, size_t size, size_t nitems, void *userdata) {
        auto *out = static_cast<std::map<std::string, std::string> *>(userdata);
        size_t n = size * nitems;
        std::string line(buf, n);
        auto colon = line.find(':');
        if (colon == std::string::npos) return n;  // status line or blank
        std::string key = line.substr(0, colon);
        std::string value = line.substr(colon + 1);
        // Trim leading/trailing whitespace and the trailing \r\n
        while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.erase(0, 1);
        while (!value.empty() && (value.back() == '\r' || value.back() == '\n')) value.pop_back();
        out->emplace(lower(key.c_str()), value);
        return n;
    }

    int perform(const char *method, const String *postBody) {
        body_.clear();
        responseHeaders_.clear();

        CURL *curl = curl_easy_init();
        if (!curl) return -1;

        struct curl_slist *headers = nullptr;
        for (auto &h : requestHeaders_) headers = curl_slist_append(headers, h.c_str());

        curl_easy_setopt(curl, CURLOPT_URL, url_.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, (long)timeoutMs_);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCb);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body_);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, headerCb);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, &responseHeaders_);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

        if (strcmp(method, "POST") == 0) {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postBody ? postBody->c_str() : "");
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, postBody ? (long)postBody->length() : 0L);
        }

        CURLcode res = curl_easy_perform(curl);
        curl_slist_free_all(headers);

        if (res != CURLE_OK) {
            fprintf(stderr, "HTTPClient: curl error for %s %s: %s\n", method, url_.c_str(), curl_easy_strerror(res));
            curl_easy_cleanup(curl);
            return -1;
        }

        long code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
        curl_easy_cleanup(curl);
        return (int)code;
    }
};
