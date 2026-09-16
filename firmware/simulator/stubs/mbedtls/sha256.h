#pragma once
#include <CommonCrypto/CommonDigest.h>
#include <cstdint>
#include <cstddef>

// Stubs the exact mbedtls SHA-256 surface device_app.h's performFirmwareOTA()
// uses, via macOS CommonCrypto - macOS-only, matching this dev machine (same
// scope assumption epaper_clock already makes with its Homebrew SDL2 paths).
// The Worker independently computes/verifies whatever this produces (see
// worker/src/lib/dither.ts's computeHash16 / firmware-bin download
// verification), so an implementation bug here would surface as a signature/
// hash mismatch rather than silently passing - self-checking.

struct mbedtls_sha256_context {
    CC_SHA256_CTX ctx;
};

inline void mbedtls_sha256_init(mbedtls_sha256_context *) {}
inline void mbedtls_sha256_free(mbedtls_sha256_context *) {}

inline int mbedtls_sha256_starts(mbedtls_sha256_context *ctx, int /*is224*/) {
    CC_SHA256_Init(&ctx->ctx);
    return 0;
}
inline int mbedtls_sha256_update(mbedtls_sha256_context *ctx, const uint8_t *input, size_t len) {
    CC_SHA256_Update(&ctx->ctx, input, (CC_LONG)len);
    return 0;
}
inline int mbedtls_sha256_finish(mbedtls_sha256_context *ctx, uint8_t output[32]) {
    CC_SHA256_Final(output, &ctx->ctx);
    return 0;
}
