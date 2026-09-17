// End-to-end pipeline test for firmware/lib/common/device_app.h's
// decryptChunksInflate() - the ACTUAL production function fetchAndDisplayImage()
// calls for packed_encoding: "deflate-raw" - not a reimplementation of its
// logic. See root CLAUDE.md's "Encrypted Image Buckets" -> packed-blob
// compression plan.
//
// Ground truth comes entirely from real, independent implementations:
//   - worker/src/lib/dither.ts's packToNibbles() (reimplemented inline in
//     gen_combined_vectors.mjs - same nibble map/algorithm) for the plaintext
//   - Node's real `zlib.deflateRawSync()` for compression
//   - Node's real `crypto.subtle` AES-256-GCM for encryption, producing the
//     exact nonce(12)||ciphertext||tag(16) shape a device would receive as
//     an /image_packed response body
//
// This test builds against the SAME stub headers (Arduino/WiFi/HTTPClient/
// mbedtls/ArduinoJson) the real simulator (sim-ee02/sim-ee04) links against,
// and #includes the real firmware/src/ee02/config.h + lib/common/device_app.h
// unmodified - so a bug in decryptChunksInflate() itself (not just in this
// test's understanding of it) would be caught here.
//
// Easiest: from firmware/simulator/, run `npm test` (or `make test`) - builds
// and runs this alongside the other two native pipeline tests, regenerating
// fixtures fresh each time. See README.md's "Native pipeline tests".
//
// To build/run just this one directly (from firmware/simulator/):
//   node tools/gen_combined_vectors.mjs
//   clang++ -std=c++17 -DARDUINO=10812 -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
//     -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 -DARDUINOJSON_ENABLE_ARDUINO_PRINT=0 \
//     -DARDUINOJSON_ENABLE_PROGMEM=0 -I stubs -I vendor/ArduinoJson \
//     -I ../lib/common -I ../src/ee02 -I . \
//     tools/test_decrypt_inflate_pipeline.cpp \
//     ../lib/common/tinfl.c ../lib/common/config_manager.cpp \
//     -framework Security -framework CoreFoundation \
//     -o tools/test_decrypt_inflate_pipeline
//   tools/test_decrypt_inflate_pipeline tools/combined_vectors

#include "Arduino.h"       // simulator stub
#include "esp_sleep.h"      // simulator stub - device_app.h's sleep-related helpers need this
#include "config.h"         // firmware/src/ee02/config.h - BOARD_ID, pins, BUFFER_SIZE, timeouts
#include "device_app.h"     // the real production code under test

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static std::vector<uint8_t> readFile(const std::string& path, bool& ok) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) {
        ok = false;
        return {};
    }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> buf(len > 0 ? (size_t)len : 0);
    if (len > 0) {
        size_t n = fread(buf.data(), 1, (size_t)len, f);
        ok = n == (size_t)len;
    } else {
        ok = true;
    }
    fclose(f);
    return buf;
}

// Mirrors fetchAndDisplayImage()'s "deflate-raw" branch exactly: read the
// 12-byte nonce, gcm_setkey+starts, decryptChunksInflate() into outBuf,
// gcm_finish(), compare against the trailing 16-byte tag - all from an
// in-memory `responseBlob` standing in for the HTTP body, via a simple
// cursor-based reader lambda instead of a real WiFiClient.
static bool decodeResponseBlob(const std::vector<uint8_t>& responseBlob, const uint8_t key[32], uint8_t* outBuf,
                                size_t outCapacity, size_t& outWritten, bool& tagVerified) {
    tagVerified = false;
    if (responseBlob.size() < 28) return false;
    size_t cipherLen = responseBlob.size() - 12 - 16;

    size_t cursor = 0;
    auto readExact = [&](uint8_t* buf, size_t len) -> bool {
        if (cursor + len > responseBlob.size()) return false;
        memcpy(buf, responseBlob.data() + cursor, len);
        cursor += len;
        return true;
    };

    uint8_t nonce[12];
    if (!readExact(nonce, sizeof(nonce))) return false;

    mbedtls_gcm_context gcmCtx;
    mbedtls_gcm_init(&gcmCtx);
    bool ok = mbedtls_gcm_setkey(&gcmCtx, MBEDTLS_CIPHER_ID_AES, key, 256) == 0;
    ok = ok && mbedtls_gcm_starts(&gcmCtx, MBEDTLS_GCM_DECRYPT, nonce, sizeof(nonce), nullptr, 0) == 0;

    if (ok) {
        ok = DeviceApp::decryptChunksInflate(gcmCtx, cipherLen, /*inflateIt=*/true, readExact, outBuf, outCapacity,
                                              outWritten);
    }

    uint8_t tag[16];
    ok = ok && readExact(tag, sizeof(tag));

    if (ok) {
        uint8_t computedTag[16];
        int rc = mbedtls_gcm_finish(&gcmCtx, computedTag, sizeof(computedTag));
        ok = rc == 0;
        if (ok) {
            uint8_t diff = 0;
            for (int i = 0; i < 16; i++) diff |= (uint8_t)(computedTag[i] ^ tag[i]);
            tagVerified = diff == 0;
        }
    }
    mbedtls_gcm_free(&gcmCtx);
    return ok;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <combined-vectors-dir>\n", argv[0]);
        return 2;
    }
    std::string dir = argv[1];

    bool okKey = false, okPlain = false, okBlob = false, okCorrupt = false;
    auto key = readFile(dir + "/key.bin", okKey);
    auto expectedPlain = readFile(dir + "/packed_plain.bin", okPlain);
    auto blob = readFile(dir + "/response_blob.bin", okBlob);
    auto corruptBlob = readFile(dir + "/response_blob_corrupted.bin", okCorrupt);
    if (!okKey || key.size() != 32 || !okPlain || !okBlob || !okCorrupt) {
        fprintf(stderr, "could not read fixtures from %s (run gen_combined_vectors.mjs first)\n", dir.c_str());
        return 2;
    }

    printf("expected plaintext (packed buffer): %zu bytes\n", expectedPlain.size());
    printf("response blob (nonce+compressed-ciphertext+tag): %zu bytes\n", blob.size());

    int failures = 0;

    // ---- Happy path: valid blob must decode to the exact expected plaintext, tag verified. ----
    {
        std::vector<uint8_t> outBuf(expectedPlain.size());
        size_t outWritten = 0;
        bool tagVerified = false;
        bool ok = decodeResponseBlob(blob, key.data(), outBuf.data(), outBuf.size(), outWritten, tagVerified);
        bool matches = ok && tagVerified && outWritten == expectedPlain.size() &&
                       memcmp(outBuf.data(), expectedPlain.data(), expectedPlain.size()) == 0;
        if (!matches) {
            fprintf(stderr,
                    "FAIL happy path: ok=%d tagVerified=%d outWritten=%zu (expected %zu), bytesMatch=%d\n", ok,
                    tagVerified, outWritten, expectedPlain.size(),
                    ok && outWritten == expectedPlain.size() &&
                        memcmp(outBuf.data(), expectedPlain.data(), expectedPlain.size()) == 0);
            failures++;
        } else {
            printf("OK: happy path - full %zu-byte buffer recovered exactly, tag verified\n", outWritten);
        }
    }

    // ---- Corrupted blob: must be rejected (either decryptChunksInflate/gcm_finish
    // fails outright, or the tag comparison fails) - imageBuffer may hold partial/
    // not-yet-authenticated bytes, but tagVerified must never come back true. ----
    {
        std::vector<uint8_t> outBuf(expectedPlain.size());
        size_t outWritten = 0;
        bool tagVerified = false;
        bool ok = decodeResponseBlob(corruptBlob, key.data(), outBuf.data(), outBuf.size(), outWritten, tagVerified);
        if (tagVerified) {
            fprintf(stderr, "FAIL corrupted-blob rejection: tag incorrectly verified as valid! ok=%d\n", ok);
            failures++;
        } else {
            printf("OK: corrupted blob correctly rejected (ok=%d, tagVerified=false as required)\n", ok);
        }
    }

    // ---- Chunk-size sensitivity: GCM_INFLATE_CHUNK_SIZE is fixed at 512 in
    // device_app.h, but re-run the happy path a few times to catch any
    // nondeterminism (there should be none - no randomness anywhere in this
    // path once inputs are fixed). ----
    for (int i = 0; i < 3; i++) {
        std::vector<uint8_t> outBuf(expectedPlain.size());
        size_t outWritten = 0;
        bool tagVerified = false;
        bool ok = decodeResponseBlob(blob, key.data(), outBuf.data(), outBuf.size(), outWritten, tagVerified);
        bool matches = ok && tagVerified && outWritten == expectedPlain.size() &&
                       memcmp(outBuf.data(), expectedPlain.data(), expectedPlain.size()) == 0;
        if (!matches) {
            fprintf(stderr, "FAIL determinism re-run %d\n", i);
            failures++;
        }
    }
    if (failures == 0) printf("OK: repeated runs deterministic\n");

    if (failures > 0) {
        printf("\n%d FAILURES\n", failures);
        return 1;
    }
    printf("\nALL PASSED\n");
    return 0;
}
