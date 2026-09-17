#!/usr/bin/env bash
# Regenerates fixtures and builds+runs every native pipeline test in this
# directory (test_gcm_stream, test_tinfl_stream, test_decrypt_inflate_pipeline)
# against the REAL production code they cover (see each test's own header
# comment) - not a simulated approximation of it. Exits nonzero if any test
# fails or fails to build, so it's safe to gate `make run`/`npm start` on.
#
# Run directly: firmware/simulator/tools/run_native_tests.sh
# Or via:       make test          (from firmware/simulator/)
#               npm test           (from firmware/simulator/)
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # firmware/simulator/, regardless of caller's cwd

CXX=${CXX:-clang++}
CXXFLAGS_JSON="-DARDUINO=10812 -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
  -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 -DARDUINOJSON_ENABLE_ARDUINO_PRINT=0 \
  -DARDUINOJSON_ENABLE_PROGMEM=0"

failures=0

echo "== Generating fixtures (real Node crypto/zlib ground truth) =="
node tools/gen_gcm_vectors.mjs || { echo "gen_gcm_vectors.mjs failed"; exit 1; }
node tools/gen_tinfl_vectors.mjs || { echo "gen_tinfl_vectors.mjs failed"; exit 1; }
node tools/gen_combined_vectors.mjs || { echo "gen_combined_vectors.mjs failed"; exit 1; }

run_test() {
  local name="$1"; shift
  local build_cmd="$1"; shift
  local run_cmd="$1"; shift
  echo
  echo "== $name: build =="
  if ! eval "$build_cmd"; then
    echo "FAIL: $name did not build"
    failures=$((failures + 1))
    return
  fi
  echo "== $name: run =="
  if ! eval "$run_cmd"; then
    echo "FAIL: $name"
    failures=$((failures + 1))
  else
    echo "PASS: $name"
  fi
}

run_test "test_gcm_stream" \
  "$CXX -std=c++17 -I stubs tools/test_gcm_stream.cpp -framework Security -framework CoreFoundation -o tools/test_gcm_stream" \
  "tools/test_gcm_stream tools/gcm_vectors"

run_test "test_tinfl_stream" \
  "$CXX -std=c++17 -I ../lib/common tools/test_tinfl_stream.cpp ../lib/common/tinfl.c -o tools/test_tinfl_stream" \
  "tools/test_tinfl_stream tools/vectors"

run_test "test_decrypt_inflate_pipeline" \
  "$CXX -std=c++17 $CXXFLAGS_JSON -I stubs -I vendor/ArduinoJson -I ../lib/common -I ../src/ee02 -I . tools/test_decrypt_inflate_pipeline.cpp ../lib/common/tinfl.c ../lib/common/config_manager.cpp -framework Security -framework CoreFoundation -o tools/test_decrypt_inflate_pipeline" \
  "tools/test_decrypt_inflate_pipeline tools/combined_vectors"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures native test(s) FAILED"
  exit 1
fi
echo "All native tests passed"
