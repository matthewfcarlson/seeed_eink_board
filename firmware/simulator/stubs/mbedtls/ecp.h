#pragma once
#include <Security/Security.h>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <vector>

// Stubs the exact mbedtls P-256 ECP/MPI surface device_app.h's
// ensureSharingKeyPair() and bucket-key-unwrap logic use, via macOS
// Security.framework — CommonCrypto (used by the other stubs here) has no
// public elliptic-curve API on this SDK. Only P-256 (SECP256R1) is ever
// requested; only the operations this project actually calls are stubbed
// (no generic bignum arithmetic, no other curves) — same minimal-surface
// approach as sha256.h/md.h.
//
// A real mbedtls_mpi/mbedtls_ecp_point on real hardware store a scalar/point
// in mbedtls's own internal representation; here they instead hold whatever
// bytes this file's own read_binary/write_binary pair needs to round-trip
// correctly through NVS storage and back into a working SecKeyRef — nothing
// outside this file (and gen_keypair/compute_shared below) ever needs to
// know that internal format isn't a literal mbedtls-compatible byte layout.
// Concretely: Security.framework's private-key export format is
// `04 || X || Y || K` (97 bytes for P-256 — the public point followed by the
// 32-byte scalar), confirmed empirically against this SDK before writing
// this file, and reimporting those exact 97 bytes reliably reconstructs a
// working key (a bare 32-byte scalar does NOT re-import — Security.framework
// requires the point alongside it). So the private mpi's "byte size" here is
// 97, not 32 — callers must size buffers via mbedtls_mpi_size(), exactly as
// well-written mbedtls client code should anyway, rather than assuming a
// fixed 32-byte P-256 scalar length. The *public* point format (65 bytes,
// uncompressed) matches both mbedtls and WebCrypto exactly, so that one
// really is a fixed, portable size.

enum mbedtls_ecp_group_id { MBEDTLS_ECP_DP_NONE, MBEDTLS_ECP_DP_SECP256R1 };
#define MBEDTLS_ECP_PF_UNCOMPRESSED 0
#define MBEDTLS_ERR_ECP_BAD_INPUT_DATA -0x4F80
#define MBEDTLS_ERR_ECP_VERIFY_FAILED -0x4E00

typedef int mbedtls_f_rng_t(void* p_rng, unsigned char* output, size_t output_len);

struct mbedtls_ecp_group {
    mbedtls_ecp_group_id id = MBEDTLS_ECP_DP_NONE;
};
inline void mbedtls_ecp_group_init(mbedtls_ecp_group* grp) { grp->id = MBEDTLS_ECP_DP_NONE; }
inline void mbedtls_ecp_group_free(mbedtls_ecp_group*) {}
inline int mbedtls_ecp_group_load(mbedtls_ecp_group* grp, mbedtls_ecp_group_id id) {
    if (id != MBEDTLS_ECP_DP_SECP256R1) return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    grp->id = id;
    return 0;
}

// See the file comment above: NOT a literal mbedtls-compatible scalar
// representation on this target — an opaque blob sized by whatever
// gen_keypair/read_binary actually produced (97 bytes after generation or a
// round-trip through NVS; 0 bytes/uninitialized otherwise).
struct mbedtls_mpi {
    std::vector<uint8_t> blob;
};
inline void mbedtls_mpi_init(mbedtls_mpi* X) { X->blob.clear(); }
inline void mbedtls_mpi_free(mbedtls_mpi* X) { X->blob.clear(); }
inline size_t mbedtls_mpi_size(const mbedtls_mpi* X) { return X->blob.size(); }
inline int mbedtls_mpi_read_binary(mbedtls_mpi* X, const uint8_t* buf, size_t buflen) {
    X->blob.assign(buf, buf + buflen);
    return 0;
}
inline int mbedtls_mpi_write_binary(const mbedtls_mpi* X, uint8_t* buf, size_t buflen) {
    if (X->blob.size() != buflen) return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    memcpy(buf, X->blob.data(), buflen);
    return 0;
}

// Raw uncompressed point (0x04 || X || Y), 65 bytes for P-256 — this format
// genuinely does match both real mbedtls and WebCrypto.
struct mbedtls_ecp_point {
    uint8_t bytes[65] = {0};
    bool valid = false;
};
inline void mbedtls_ecp_point_init(mbedtls_ecp_point* P) { P->valid = false; }
inline void mbedtls_ecp_point_free(mbedtls_ecp_point*) {}
inline int mbedtls_ecp_point_write_binary(const mbedtls_ecp_group*, const mbedtls_ecp_point* P,
                                           int /*format*/, size_t* olen, uint8_t* buf, size_t buflen) {
    if (!P->valid || buflen < 65) return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    memcpy(buf, P->bytes, 65);
    *olen = 65;
    return 0;
}
inline int mbedtls_ecp_point_read_binary(const mbedtls_ecp_group*, mbedtls_ecp_point* P,
                                          const uint8_t* buf, size_t ilen) {
    if (ilen != 65 || buf[0] != 0x04) return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    memcpy(P->bytes, buf, 65);
    P->valid = true;
    return 0;
}

namespace sim_ecdh_detail {

inline SecKeyRef createPrivateKeyFromBlob(const std::vector<uint8_t>& blob) {
    if (blob.size() != 97) return nullptr;
    CFDataRef data = CFDataCreate(nullptr, blob.data(), (CFIndex)blob.size());
    CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(attrs, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
    CFDictionarySetValue(attrs, kSecAttrKeyClass, kSecAttrKeyClassPrivate);
    CFErrorRef error = nullptr;
    SecKeyRef key = SecKeyCreateWithData(data, attrs, &error);
    CFRelease(data);
    CFRelease(attrs);
    if (error) CFRelease(error);
    return key;
}

inline SecKeyRef createPublicKeyFromPoint(const uint8_t point[65]) {
    CFDataRef data = CFDataCreate(nullptr, point, 65);
    CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(attrs, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
    CFDictionarySetValue(attrs, kSecAttrKeyClass, kSecAttrKeyClassPublic);
    CFErrorRef error = nullptr;
    SecKeyRef key = SecKeyCreateWithData(data, attrs, &error);
    CFRelease(data);
    CFRelease(attrs);
    if (error) CFRelease(error);
    return key;
}

}  // namespace sim_ecdh_detail

/** Generates a fresh P-256 keypair. `d`'s blob afterward is the 97-byte
 *  Security.framework private-key export (04||X||Y||K) — persist it whole
 *  via mbedtls_mpi_size()/write_binary(), not as a bare 32-byte scalar. */
inline int mbedtls_ecp_gen_keypair(mbedtls_ecp_group* grp, mbedtls_mpi* d, mbedtls_ecp_point* Q,
                                    mbedtls_f_rng_t* /*f_rng*/, void* /*p_rng*/) {
    if (grp->id != MBEDTLS_ECP_DP_SECP256R1) return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;

    CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(attrs, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
    CFDictionarySetValue(attrs, kSecAttrKeySizeInBits, CFSTR("256"));
    CFErrorRef error = nullptr;
    SecKeyRef priv = SecKeyCreateRandomKey(attrs, &error);
    CFRelease(attrs);
    if (!priv) {
        if (error) CFRelease(error);
        return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    }

    CFDataRef exported = SecKeyCopyExternalRepresentation(priv, &error);
    CFRelease(priv);
    if (!exported || CFDataGetLength(exported) != 97) {
        if (exported) CFRelease(exported);
        if (error) CFRelease(error);
        return MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    }

    const uint8_t* bytes = CFDataGetBytePtr(exported);
    d->blob.assign(bytes, bytes + 97);
    memcpy(Q->bytes, bytes, 65);
    Q->valid = true;
    CFRelease(exported);
    return 0;
}
