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
// Also stubs the streaming mbedtls_gcm_starts()/_update()/_finish() trio -
// added for packed-blob compression (see root CLAUDE.md's "Encrypted Image
// Buckets" -> packed-blob compression plan): device_app.h's
// decryptChunksInflate() needs to GCM-decrypt a stream in small fixed-size
// chunks rather than all at once, since the ciphertext no longer lands
// contiguously in the display buffer once it's DEFLATE-compressed. Real
// mbedtls's mbedtls_gcm_update() requires every call except the last to pass
// a length that's a multiple of 16 bytes and only guarantees behavior for
// mode MBEDTLS_GCM_DECRYPT xor MBEDTLS_GCM_ENCRYPT consistently across a
// stream - this stub is deliberately looser (accepts any per-call length, to
// let its own test harness exercise adversarial chunk boundaries) but, like
// the one-shot function above, ONLY implements MBEDTLS_GCM_DECRYPT correctly:
// GHASH always absorbs `input` directly, which is only correct when `input`
// is already ciphertext (true for MBEDTLS_GCM_DECRYPT; would need to hash
// `output` instead for MBEDTLS_GCM_ENCRYPT, which this project never uses via
// the streaming API). Cross-checked against real Node `crypto.subtle`
// AES-256-GCM ciphertext and against this same file's one-shot
// mbedtls_gcm_auth_decrypt() across multiple chunk sizes - see
// firmware/simulator/tools/test_gcm_stream.cpp.
//
// This is simulator-only code (macOS dev tooling) - real hardware links the
// genuine ESP-IDF mbedtls GCM implementation, so any bug here affects only
// local testing fidelity, never a real device's security.

enum mbedtls_cipher_id_t { MBEDTLS_CIPHER_ID_NONE, MBEDTLS_CIPHER_ID_AES };

#define MBEDTLS_ERR_GCM_AUTH_FAILED -0x0012
#define MBEDTLS_ERR_GCM_BAD_INPUT -0x0014

// Real mbedtls's mbedtls_gcm_starts() mode argument - only MBEDTLS_GCM_DECRYPT
// is actually implemented correctly below (see mbedtls_gcm_update()'s doc
// comment), matching this file's existing "decrypt only" scope note.
#define MBEDTLS_GCM_ENCRYPT 1
#define MBEDTLS_GCM_DECRYPT 0

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

    // Streaming (mbedtls_gcm_starts/_update/_finish) state - unused by the
    // one-shot mbedtls_gcm_auth_decrypt() below, which keeps its own locals.
    uint8_t H[16];               // hash subkey (E(key, 0^128))
    uint8_t J0[16];               // pre-increment counter block, derived from the IV
    uint8_t counter[16];          // current CTR counter block (starts at J0+1)
    uint8_t keystream[16];        // cached E(key, counter) for the current counter value
    size_t keystreamPos;          // next unused byte index into `keystream` (16 = exhausted)
    uint8_t Y[16];                // running GHASH accumulator (AAD already absorbed by starts())
    uint8_t pendingBlock[16];     // partial trailing GHASH input block, buffered across update() calls
    size_t pendingLen;            // how many bytes of pendingBlock are filled (0..15)
    uint64_t addLenBits;
    uint64_t dataLenBits;
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

/** Starts a streaming GCM operation - see this file's header comment for the
 *  MBEDTLS_GCM_DECRYPT-only scope note. Absorbs all of `add` (AAD) into GHASH
 *  immediately (matching real mbedtls, which takes AAD only here, not per
 *  mbedtls_gcm_update() call) - this project always calls with add_len == 0,
 *  but the general case is implemented for fidelity with the real API. */
inline int mbedtls_gcm_starts(mbedtls_gcm_context* ctx, int mode, const uint8_t* iv, size_t iv_len,
                               const uint8_t* add, size_t add_len) {
    using namespace sim_gcm_detail;
    (void)mode;  // GHASH/CTR math below is only correct for MBEDTLS_GCM_DECRYPT - see header comment.
    if (iv_len != 12) return MBEDTLS_ERR_GCM_BAD_INPUT;

    memset(ctx->H, 0, 16);
    aesEcbEncryptBlock(ctx->key, ctx->H, ctx->H);

    memcpy(ctx->J0, iv, 12);
    ctx->J0[12] = 0;
    ctx->J0[13] = 0;
    ctx->J0[14] = 0;
    ctx->J0[15] = 1;

    memcpy(ctx->counter, ctx->J0, 16);
    incr32(ctx->counter);  // per NIST SP800-38D, the data keystream starts at J0+1, not J0 itself.
    ctx->keystreamPos = 16;  // forces a keystream block to be generated on first use.

    memset(ctx->Y, 0, 16);
    ctx->pendingLen = 0;
    ctx->addLenBits = (uint64_t)add_len * 8;
    ctx->dataLenBits = 0;

    size_t off = 0;
    while (off < add_len) {
        uint8_t block[16] = {0};
        size_t n = add_len - off < 16 ? add_len - off : 16;
        memcpy(block, add + off, n);
        for (int j = 0; j < 16; j++) ctx->Y[j] ^= block[j];
        uint8_t tmp[16];
        gf128Mul(tmp, ctx->Y, ctx->H);
        memcpy(ctx->Y, tmp, 16);
        off += n;
    }
    return 0;
}

/** Feeds `length` more ciphertext bytes through an in-progress streaming GCM
 *  decrypt started by mbedtls_gcm_starts() - unlike mbedtls_gcm_auth_decrypt(),
 *  `input` and `output` must NOT alias (real mbedtls documents the same
 *  restriction for this call), since CTR keystream bytes are consumed
 *  incrementally per-byte here rather than XORed over a whole buffer at once.
 *  GHASH absorbs `input` (ciphertext) directly - only correct for
 *  MBEDTLS_GCM_DECRYPT, per this file's header comment. */
inline int mbedtls_gcm_update(mbedtls_gcm_context* ctx, size_t length, const uint8_t* input, uint8_t* output) {
    using namespace sim_gcm_detail;
    if (input == output && length > 0) return MBEDTLS_ERR_GCM_BAD_INPUT;

    ctx->dataLenBits += (uint64_t)length * 8;

    for (size_t i = 0; i < length; i++) {
        if (ctx->keystreamPos == 16) {
            aesEcbEncryptBlock(ctx->key, ctx->counter, ctx->keystream);
            incr32(ctx->counter);
            ctx->keystreamPos = 0;
        }
        uint8_t c = input[i];
        output[i] = (uint8_t)(c ^ ctx->keystream[ctx->keystreamPos++]);

        ctx->pendingBlock[ctx->pendingLen++] = c;
        if (ctx->pendingLen == 16) {
            for (int j = 0; j < 16; j++) ctx->Y[j] ^= ctx->pendingBlock[j];
            uint8_t tmp[16];
            gf128Mul(tmp, ctx->Y, ctx->H);
            memcpy(ctx->Y, tmp, 16);
            ctx->pendingLen = 0;
        }
    }
    return 0;
}

/** Finishes a streaming GCM operation, producing the computed tag - the
 *  caller (device_app.h) must compare this against the stream's actual
 *  trailing tag bytes itself (unlike mbedtls_gcm_auth_decrypt(), which does
 *  that comparison internally) since the streaming API has no way to see the
 *  tag until every ciphertext byte has already passed through
 *  mbedtls_gcm_update(). */
inline int mbedtls_gcm_finish(mbedtls_gcm_context* ctx, uint8_t* tag, size_t tag_len) {
    using namespace sim_gcm_detail;
    if (tag_len != 16) return MBEDTLS_ERR_GCM_BAD_INPUT;

    if (ctx->pendingLen > 0) {
        uint8_t block[16] = {0};
        memcpy(block, ctx->pendingBlock, ctx->pendingLen);
        for (int j = 0; j < 16; j++) ctx->Y[j] ^= block[j];
        uint8_t tmp[16];
        gf128Mul(tmp, ctx->Y, ctx->H);
        memcpy(ctx->Y, tmp, 16);
        ctx->pendingLen = 0;
    }

    uint8_t lenBlock[16];
    for (int i = 0; i < 8; i++) lenBlock[i] = (uint8_t)(ctx->addLenBits >> (56 - 8 * i));
    for (int i = 0; i < 8; i++) lenBlock[8 + i] = (uint8_t)(ctx->dataLenBits >> (56 - 8 * i));
    for (int j = 0; j < 16; j++) ctx->Y[j] ^= lenBlock[j];
    uint8_t tmp[16];
    gf128Mul(tmp, ctx->Y, ctx->H);
    memcpy(ctx->Y, tmp, 16);

    uint8_t tagMask[16];
    aesEcbEncryptBlock(ctx->key, ctx->J0, tagMask);
    for (int i = 0; i < 16; i++) tag[i] = (uint8_t)(ctx->Y[i] ^ tagMask[i]);
    return 0;
}
