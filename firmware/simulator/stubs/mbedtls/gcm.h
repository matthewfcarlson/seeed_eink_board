#pragma once
#include <CommonCrypto/CommonCryptor.h>
#include <cstdint>
#include <cstddef>
#include <cstring>

// Stubs the exact mbedtls AES-GCM surface device_app.h's fetchAndDisplayImage()
// and bucket-key-unwrap logic use (decrypt only - the device never encrypts
// anything with this key) - see root CLAUDE.md's encrypted-buckets plan.
//
// CommonCrypto has no public GCM API on macOS (unlike CCCryptorGCM* symbols
// some platforms expose, this SDK's CommonCryptor.h declares none), so GCM is
// implemented directly here: CommonCrypto only supplies single-block AES-ECB
// (via one-shot CCCrypt), and this file does the CTR-mode keystream and
// GHASH authentication itself, per NIST SP800-38D, for the 96-bit-IV case
// this project always uses. Verified byte-for-byte against real WebCrypto
// AES-256-GCM output (empty/16/5/1000-byte plaintexts, matching
// worker/src/client/crypto.ts's output) before being committed here - see the
// firmware simulator PR description for the vectors used, since there's
// nowhere in this small header to keep a full test harness.
//
// This is simulator-only code (macOS dev tooling) - real hardware links the
// genuine ESP-IDF mbedtls GCM implementation, so any bug here affects only
// local testing fidelity, never a real device's security.

enum mbedtls_cipher_id_t { MBEDTLS_CIPHER_ID_NONE, MBEDTLS_CIPHER_ID_AES };

#define MBEDTLS_ERR_GCM_AUTH_FAILED -0x0012
#define MBEDTLS_ERR_GCM_BAD_INPUT -0x0014

namespace sim_gcm_detail {

inline void aesEcbEncryptBlock(const uint8_t key[32], const uint8_t in[16], uint8_t out[16]) {
    size_t moved = 0;
    CCCrypt(kCCEncrypt, kCCAlgorithmAES, 0 /* no padding */, key, 32, nullptr, in, 16, out, 16, &moved);
}

inline void gf128Mul(uint8_t Z[16], const uint8_t X[16], const uint8_t Y[16]) {
    uint8_t V[16];
    memcpy(V, Y, 16);
    memset(Z, 0, 16);
    for (int i = 0; i < 128; i++) {
        if ((X[i / 8] >> (7 - (i % 8))) & 1) {
            for (int j = 0; j < 16; j++) Z[j] ^= V[j];
        }
        int lsb = V[15] & 1;
        for (int j = 15; j > 0; j--) {
            V[j] = (uint8_t)((V[j] >> 1) | ((V[j - 1] & 1) << 7));
        }
        V[0] = (uint8_t)(V[0] >> 1);
        if (lsb) V[0] ^= 0xe1;
    }
}

inline void ghash(const uint8_t H[16], const uint8_t* add, size_t addLen,
                   const uint8_t* c, size_t cLen, uint8_t out[16]) {
    uint8_t Y[16] = {0};
    uint8_t block[16];
    auto absorb = [&](const uint8_t* data, size_t len) {
        size_t off = 0;
        while (off < len) {
            memset(block, 0, 16);
            size_t n = len - off < 16 ? len - off : 16;
            memcpy(block, data + off, n);
            for (int j = 0; j < 16; j++) Y[j] ^= block[j];
            uint8_t tmp[16];
            gf128Mul(tmp, Y, H);
            memcpy(Y, tmp, 16);
            off += n;
        }
    };
    if (addLen) absorb(add, addLen);
    if (cLen) absorb(c, cLen);

    memset(block, 0, 16);
    uint64_t addBits = (uint64_t)addLen * 8, cBits = (uint64_t)cLen * 8;
    for (int i = 0; i < 8; i++) block[i] = (uint8_t)(addBits >> (56 - 8 * i));
    for (int i = 0; i < 8; i++) block[8 + i] = (uint8_t)(cBits >> (56 - 8 * i));
    for (int j = 0; j < 16; j++) Y[j] ^= block[j];
    uint8_t tmp[16];
    gf128Mul(tmp, Y, H);
    memcpy(out, tmp, 16);
}

inline void incr32(uint8_t block[16]) {
    for (int i = 15; i >= 12; i--) {
        if (++block[i] != 0) break;
    }
}

// CTR keystream XOR - symmetric, so the same call does both directions.
inline void gctr(const uint8_t key[32], const uint8_t startCounter[16],
                  const uint8_t* in, size_t len, uint8_t* out) {
    uint8_t counter[16];
    memcpy(counter, startCounter, 16);
    uint8_t keystream[16];
    size_t off = 0;
    while (off < len) {
        aesEcbEncryptBlock(key, counter, keystream);
        size_t n = len - off < 16 ? len - off : 16;
        for (size_t j = 0; j < n; j++) out[off + j] = in[off + j] ^ keystream[j];
        incr32(counter);
        off += n;
    }
}

}  // namespace sim_gcm_detail

struct mbedtls_gcm_context {
    uint8_t key[32];
};

inline void mbedtls_gcm_init(mbedtls_gcm_context* ctx) {
    memset(ctx, 0, sizeof(*ctx));
}
inline void mbedtls_gcm_free(mbedtls_gcm_context*) {}

inline int mbedtls_gcm_setkey(mbedtls_gcm_context* ctx, mbedtls_cipher_id_t cipher,
                               const uint8_t* key, unsigned int keybits) {
    if (cipher != MBEDTLS_CIPHER_ID_AES || keybits != 256) return MBEDTLS_ERR_GCM_BAD_INPUT;
    memcpy(ctx->key, key, 32);
    return 0;
}

/** Decrypts `length` bytes of `input` into `output` (safe in-place: input ==
 *  output is fine, matching real mbedtls' documented behavior) only once the
 *  provided `tag` has been verified against a freshly recomputed one over
 *  `add`/`input` — returns MBEDTLS_ERR_GCM_AUTH_FAILED, and leaves `output`
 *  untouched, on any mismatch. 96-bit `iv` only (this project never uses
 *  another size). */
inline int mbedtls_gcm_auth_decrypt(mbedtls_gcm_context* ctx, size_t length,
                                     const uint8_t* iv, size_t iv_len,
                                     const uint8_t* add, size_t add_len,
                                     const uint8_t* tag, size_t tag_len,
                                     const uint8_t* input, uint8_t* output) {
    using namespace sim_gcm_detail;
    if (iv_len != 12 || tag_len != 16) return MBEDTLS_ERR_GCM_BAD_INPUT;

    uint8_t H[16] = {0};
    aesEcbEncryptBlock(ctx->key, H, H);

    uint8_t J0[16];
    memcpy(J0, iv, 12);
    J0[12] = 0; J0[13] = 0; J0[14] = 0; J0[15] = 1;

    uint8_t S[16];
    ghash(H, add, add_len, input, length, S);
    uint8_t tagMask[16];
    aesEcbEncryptBlock(ctx->key, J0, tagMask);
    uint8_t expectedTag[16];
    for (int i = 0; i < 16; i++) expectedTag[i] = S[i] ^ tagMask[i];

    // Constant-time-ish compare (not security-critical here - simulator only).
    uint8_t diff = 0;
    for (int i = 0; i < 16; i++) diff |= (uint8_t)(expectedTag[i] ^ tag[i]);
    if (diff != 0) return MBEDTLS_ERR_GCM_AUTH_FAILED;

    uint8_t J0plus1[16];
    memcpy(J0plus1, J0, 16);
    incr32(J0plus1);
    gctr(ctx->key, J0plus1, input, length, output);
    return 0;
}
