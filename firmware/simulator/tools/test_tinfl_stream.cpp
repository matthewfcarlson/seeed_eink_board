// Standalone verification for firmware/lib/common/tinfl.{h,c} - see root
// CLAUDE.md's "Encrypted Image Buckets" -> packed-blob compression plan.
//
// Compares tinfl_decompress() output, fed in several different chunk sizes
// (mimicking exactly how device_app.h's decryptChunksInflate() drives it a
// GCM_INFLATE_CHUNK_SIZE-worth of already-decrypted bytes at a time), against:
//   1. The known-correct plaintext.
//   2. A one-shot (single call, all input at once) decompression - so a bug
//      that only manifests when input arrives in pieces is caught even if
//      the one-shot path happens to work.
//
// Test vectors are real `zlib.deflateRawSync()` output from Node (see
// gen_tinfl_vectors.mjs), covering: empty input, tiny input, highly
// repetitive input (two patterns), incompressible/random input, a realistic
// packed-4bpp-dithered-image-shaped input, a single byte, an exact
// AES-block-size (16 byte) input, and a near-worst-case-for-memory 960000
// byte mostly-flat input (EE02's real buffer size).
//
// Easiest: from firmware/simulator/, run `npm test` (or `make test`) - builds
// and runs this alongside the other two native pipeline tests, regenerating
// fixtures fresh each time. See README.md's "Native pipeline tests".
//
// To build/run just this one directly (from firmware/simulator/):
//   node tools/gen_tinfl_vectors.mjs
//   clang++ -std=c++17 -I ../lib/common tools/test_tinfl_stream.cpp \
//     ../lib/common/tinfl.c -o tools/test_tinfl_stream
//   tools/test_tinfl_stream tools/vectors

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "tinfl.h"

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

// Decompresses `compressed` into a buffer of exactly `expectedLen` bytes,
// feeding tinfl `chunkSize` compressed bytes at a time (0 means "all at
// once"). Returns {success, output}.
static bool inflateInChunks(const std::vector<uint8_t>& compressed, size_t expectedLen, size_t chunkSize,
                             std::vector<uint8_t>& out) {
    out.assign(expectedLen, 0);
    tinfl_decompressor decomp;
    tinfl_init(&decomp);

    if (chunkSize == 0) chunkSize = compressed.size() > 0 ? compressed.size() : 1;

    size_t inOfs = 0;
    size_t outWritten = 0;
    while (true) {
        size_t haveInput = compressed.size() - inOfs;
        size_t thisChunk = haveInput < chunkSize ? haveInput : chunkSize;
        bool moreAfterThisChunk = (inOfs + thisChunk) < compressed.size();

        size_t chunkInOfs = 0;
        while (chunkInOfs < thisChunk || (thisChunk == 0 && chunkInOfs == 0)) {
            size_t inSize = thisChunk - chunkInOfs;
            size_t outSize = expectedLen - outWritten;
            uint32_t flags = TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF |
                              (moreAfterThisChunk || chunkInOfs + inSize < thisChunk ? TINFL_FLAG_HAS_MORE_INPUT : 0);
            tinfl_status st = tinfl_decompress(&decomp, compressed.data() + inOfs + chunkInOfs, &inSize, out.data(),
                                                out.data() + outWritten, &outSize, flags);
            chunkInOfs += inSize;
            outWritten += outSize;

            if (st == TINFL_STATUS_DONE) {
                out.resize(outWritten);
                return true;
            }
            if (st < 0) {
                fprintf(stderr, "  tinfl_decompress failed, status=%d\n", (int)st);
                return false;
            }
            if (st == TINFL_STATUS_HAS_MORE_OUTPUT) {
                fprintf(stderr, "  tinfl_decompress wants more output space than expectedLen=%zu allows\n", expectedLen);
                return false;
            }
            if (st == TINFL_STATUS_NEEDS_MORE_INPUT) break;  // go get the next chunk
            if (thisChunk == 0) break;                       // avoid infinite loop on a zero-size chunk
        }

        inOfs += thisChunk;
        if (inOfs >= compressed.size()) {
            // Ran out of input without seeing TINFL_STATUS_DONE - only acceptable
            // for the empty-plaintext vector, whose 2-byte "empty block" deflate
            // stream can legitimately finish inside the exact last chunk boundary
            // check above; getting here means it did NOT and is a real failure.
            fprintf(stderr, "  input exhausted before TINFL_STATUS_DONE\n");
            return false;
        }
    }
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <vectors-dir>\n", argv[0]);
        return 2;
    }
    std::string dir = argv[1];

    // Indices must match gen_tinfl_vectors.mjs.
    const int kNumVectors = 9;
    const size_t chunkSizes[] = {0 /* one-shot */, 1, 3, 7, 16, 64, 4096, 65536};

    int failures = 0;
    int testsRun = 0;

    for (int i = 0; i < kNumVectors; i++) {
        bool ok1 = false, ok2 = false;
        auto plain = readFile(dir + "/vec" + std::to_string(i) + ".plain.bin", ok1);
        auto compressed = readFile(dir + "/vec" + std::to_string(i) + ".deflate.bin", ok2);
        if (!ok1 || !ok2) {
            fprintf(stderr, "vector %d: could not read fixture files (did you run gen_tinfl_vectors.mjs?)\n", i);
            failures++;
            continue;
        }
        printf("vector %d: plain=%zu compressed=%zu\n", i, plain.size(), compressed.size());

        for (size_t chunkSize : chunkSizes) {
            testsRun++;
            std::vector<uint8_t> out;
            bool success = inflateInChunks(compressed, plain.size(), chunkSize, out);
            bool matches = success && out.size() == plain.size() && memcmp(out.data(), plain.data(), plain.size()) == 0;
            if (!matches) {
                fprintf(stderr, "  FAIL: vector %d, chunkSize=%zu (0=one-shot) - success=%d, outLen=%zu (expected %zu)\n",
                        i, chunkSize, success, out.size(), plain.size());
                failures++;
            } else {
                printf("  ok: chunkSize=%zu%s\n", chunkSize, chunkSize == 0 ? " (one-shot)" : "");
            }
        }
    }

    printf("\n%d/%d chunked-decompress checks passed\n", testsRun - failures, testsRun);
    if (failures > 0) {
        printf("%d FAILURES\n", failures);
        return 1;
    }
    printf("ALL PASSED\n");
    return 0;
}
