#pragma once
#include "ecp.h"

// See ecp.h's file comment for the overall approach. This is the one
// function device_app.h actually calls to turn (our private key blob, their
// public point) into a shared secret — everything else needed is already in
// ecp.h.

/** `z`'s blob afterward is the 32-byte raw shared X-coordinate, matching
 *  WebCrypto's ECDH deriveBits output exactly (big-endian, fixed 32 bytes for
 *  P-256) — safe to feed straight into HKDF. `d`'s blob must be the 97-byte
 *  private-key export from mbedtls_ecp_gen_keypair (or a value round-tripped
 *  through NVS via mbedtls_mpi_write_binary/read_binary) — a bare 32-byte
 *  scalar will fail to reconstruct a usable key here (see ecp.h). */
inline int mbedtls_ecdh_compute_shared(mbedtls_ecp_group* grp, mbedtls_mpi* z,
                                        const mbedtls_ecp_point* Q, const mbedtls_mpi* d,
                                        mbedtls_f_rng_t* /*f_rng*/, void* /*p_rng*/) {
    if (grp->id != MBEDTLS_ECP_DP_SECP256R1 || !Q->valid) return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;

    SecKeyRef privKey = sim_ecdh_detail::createPrivateKeyFromBlob(d->blob);
    SecKeyRef pubKey = sim_ecdh_detail::createPublicKeyFromPoint(Q->bytes);
    if (!privKey || !pubKey) {
        if (privKey) CFRelease(privKey);
        if (pubKey) CFRelease(pubKey);
        return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    }

    CFMutableDictionaryRef params = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFErrorRef error = nullptr;
    CFDataRef shared = SecKeyCopyKeyExchangeResult(privKey, kSecKeyAlgorithmECDHKeyExchangeStandard, pubKey, params, &error);
    CFRelease(params);
    CFRelease(privKey);
    CFRelease(pubKey);
    if (!shared) {
        if (error) CFRelease(error);
        return MBEDTLS_ERR_ECP_VERIFY_FAILED;
    }

    const uint8_t* bytes = CFDataGetBytePtr(shared);
    CFIndex len = CFDataGetLength(shared);
    if (len != 32) {
        CFRelease(shared);
        return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    }
    z->blob.assign(bytes, bytes + len);
    CFRelease(shared);
    return 0;
}
