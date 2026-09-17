#pragma once

// Public-domain single-function raw-DEFLATE decompressor ("tinfl"), extracted
// from miniz.c 2.1.0 by Rich Geldreich (unlicense.org) - the same, unmodified
// tinfl_decompress() coroutine used by (among many other things) esptool's own
// compressed-flashing stub, already vendored on this machine at
// ~/git/vyknoll/firmware/packages/tool-esptoolpy/flasher_stub/{miniz.c,include/miniz.h}
// (that copy already had MINIZ_NO_ARCHIVE_APIS/MINIZ_NO_ZLIB_APIS/MINIZ_NO_STDIO/
// MINIZ_NO_MALLOC/MINIZ_NO_TIME set, i.e. was already trimmed for a small
// embedded target - the same trim this project wants, taken one step further
// by physically dropping the tdefl (compression) and higher-level
// malloc-based helper code we don't call at all, to save flash on both ESP32
// targets). Nothing about the actual Huffman/LZ77 decompression algorithm
// below has been changed - only unrelated (compression/archive/zlib-wrapper)
// code was removed and comments trimmed. See CLAUDE.md's "Encrypted Image
// Buckets" -> packed-blob compression section for how this is used
// (device_app.h streams AES-GCM-decrypted chunks of a client-side
// `deflate-raw`-compressed packed 4bpp buffer through this, straight into
// display.getBuffer() via TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF, with no
// second full-size allocation).
//
// Verified against real Node `zlib.deflateRawSync()` output (empty, tiny,
// highly-repetitive, and incompressible/random inputs, plus real packed-4bpp
// dithered image data), including streamed in arbitrary chunk sizes - see
// firmware/simulator/tools/test_tinfl_stream.cpp.

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned char mz_uint8;
typedef signed short mz_int16;
typedef unsigned int mz_uint32;
typedef unsigned int mz_uint;
typedef uint64_t mz_uint64;

#define MZ_MACRO_END while (0)

// Decompression flags used by tinfl_decompress() - see tinfl.c's call sites
// in device_app.h for which of these this project actually uses (raw deflate,
// non-wrapping output buffer, no adler32/zlib-header - this is DEFLATE per
// RFC 1951, not zlib per RFC 1950).
enum {
    TINFL_FLAG_PARSE_ZLIB_HEADER = 1,
    TINFL_FLAG_HAS_MORE_INPUT = 2,
    TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF = 4,
    TINFL_FLAG_COMPUTE_ADLER32 = 8
};

// Max size of the LZ dictionary - only relevant when NOT using a
// non-wrapping output buffer; this project always does, so the whole
// display buffer must be at least this large (960000/384000 bytes >> 32768).
#define TINFL_LZ_DICT_SIZE 32768

typedef enum {
    TINFL_STATUS_FAILED_CANNOT_MAKE_PROGRESS = -4,
    TINFL_STATUS_BAD_PARAM = -3,
    TINFL_STATUS_ADLER32_MISMATCH = -2,
    TINFL_STATUS_FAILED = -1,
    TINFL_STATUS_DONE = 0,
    TINFL_STATUS_NEEDS_MORE_INPUT = 1,
    TINFL_STATUS_HAS_MORE_OUTPUT = 2
} tinfl_status;

// Internal/private state - must be defined here (not opaque) since callers
// stack/RTC-allocate it, matching real miniz.h.
enum {
    TINFL_MAX_HUFF_TABLES = 3,
    TINFL_MAX_HUFF_SYMBOLS_0 = 288,
    TINFL_MAX_HUFF_SYMBOLS_1 = 32,
    TINFL_MAX_HUFF_SYMBOLS_2 = 19,
    TINFL_FAST_LOOKUP_BITS = 10,
    TINFL_FAST_LOOKUP_SIZE = 1 << TINFL_FAST_LOOKUP_BITS
};

typedef struct {
    mz_uint8 m_code_size[TINFL_MAX_HUFF_SYMBOLS_0];
    mz_int16 m_look_up[TINFL_FAST_LOOKUP_SIZE], m_tree[TINFL_MAX_HUFF_SYMBOLS_0 * 2];
} tinfl_huff_table;

// Real miniz picks 64- vs 32-bit bit-buffer width by target (x86_64/arm64
// hosts get 64-bit, 32-bit targets like the ESP32's Xtensa core get 32-bit) -
// both are the genuine, exercised-upstream code path, not something invented
// for this project; correctness doesn't depend on which one a given build
// picks, only performance.
#if defined(_M_X64) || defined(_WIN64) || defined(__MINGW64__) || defined(_LP64) || defined(__LP64__) || \
    defined(__ia64__) || defined(__x86_64__)
#define TINFL_USE_64BIT_BITBUF 1
#else
#define TINFL_USE_64BIT_BITBUF 0
#endif

#if TINFL_USE_64BIT_BITBUF
typedef mz_uint64 tinfl_bit_buf_t;
#else
typedef mz_uint32 tinfl_bit_buf_t;
#endif

struct tinfl_decompressor_tag {
    mz_uint32 m_state, m_num_bits, m_zhdr0, m_zhdr1, m_z_adler32, m_final, m_type, m_check_adler32, m_dist,
        m_counter, m_num_extra, m_table_sizes[TINFL_MAX_HUFF_TABLES];
    tinfl_bit_buf_t m_bit_buf;
    size_t m_dist_from_out_buf_start;
    tinfl_huff_table m_tables[TINFL_MAX_HUFF_TABLES];
    mz_uint8 m_raw_header[4], m_len_codes[TINFL_MAX_HUFF_SYMBOLS_0 + TINFL_MAX_HUFF_SYMBOLS_1 + 137];
};
typedef struct tinfl_decompressor_tag tinfl_decompressor;

// Initializes the decompressor to its initial state - call once before the
// first tinfl_decompress() call for a given stream.
#define tinfl_init(r)     \
    do                    \
    {                     \
        (r)->m_state = 0; \
    }                     \
    MZ_MACRO_END
#define tinfl_get_adler32(r) (r)->m_check_adler32

// Main low-level decompressor coroutine - the only function actually needed
// for decompression, and the only one this project calls. See miniz's own
// docs (preserved verbatim in tinfl.c above the function) for the exact
// input/output-buffer-advancing contract; device_app.h's call site documents
// how this project drives it across HTTP chunk boundaries.
tinfl_status tinfl_decompress(tinfl_decompressor *r, const mz_uint8 *pIn_buf_next, size_t *pIn_buf_size,
                               mz_uint8 *pOut_buf_start, mz_uint8 *pOut_buf_next, size_t *pOut_buf_size,
                               const mz_uint32 decomp_flags);

#ifdef __cplusplus
}
#endif
