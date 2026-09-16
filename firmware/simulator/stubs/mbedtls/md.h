#pragma once
#include <CommonCrypto/CommonHMAC.h>
#include <cstdint>
#include <cstddef>

// Stubs the exact mbedtls HMAC surface device_app.h's computeDeviceSignature()
// uses, via macOS CommonCrypto. This is the request-signing path
// worker/src/lib/device-signature.ts verifies server-side, so a mistake here
// surfaces immediately as a 401, not silently - see sha256.h's comment.

enum mbedtls_md_type_t { MBEDTLS_MD_NONE, MBEDTLS_MD_SHA256 };

struct mbedtls_md_info_t {
    int dummy;
};
inline const mbedtls_md_info_t SIM_SHA256_MD_INFO{};

inline const mbedtls_md_info_t *mbedtls_md_info_from_type(mbedtls_md_type_t type) {
    return type == MBEDTLS_MD_SHA256 ? &SIM_SHA256_MD_INFO : nullptr;
}

struct mbedtls_md_context_t {
    CCHmacContext hmacCtx;
};

inline void mbedtls_md_init(mbedtls_md_context_t *) {}
inline void mbedtls_md_free(mbedtls_md_context_t *) {}
// Real mbedtls_md_setup() records which algorithm to use; the actual key is
// supplied later via hmac_starts(), which is also where CommonCrypto's
// CCHmacInit() needs it - so setup() itself has nothing to do here.
inline int mbedtls_md_setup(mbedtls_md_context_t *, const mbedtls_md_info_t *, int /*hmac*/) {
    return 0;
}
inline int mbedtls_md_hmac_starts(mbedtls_md_context_t *ctx, const uint8_t *key, size_t keyLen) {
    CCHmacInit(&ctx->hmacCtx, kCCHmacAlgSHA256, key, keyLen);
    return 0;
}
inline int mbedtls_md_hmac_update(mbedtls_md_context_t *ctx, const uint8_t *input, size_t len) {
    CCHmacUpdate(&ctx->hmacCtx, input, len);
    return 0;
}
inline int mbedtls_md_hmac_finish(mbedtls_md_context_t *ctx, uint8_t *output) {
    CCHmacFinal(&ctx->hmacCtx, output);
    return 0;
}
