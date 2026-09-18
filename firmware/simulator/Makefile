# Native device simulator - compiles the REAL firmware/lib/common/*.cpp and a
# chosen board's display.cpp/main.cpp directly (see main_native.cpp and
# README.md), against stub headers standing in for the Arduino/ESP32/NimBLE
# APIs. Modeled on ~/git/epaper_clock/simulator/Makefile's approach.
#
#   make BOARD=ee02        - build sim-ee02 (default)
#   make BOARD=ee04        - build sim-ee04
#   make BOARD=ee02 run    - build and run
#   make clean

CXX = clang++
SDL_CFLAGS := $(shell sdl2-config --cflags)
SDL_LIBS   := $(shell sdl2-config --libs)

# ARDUINO=<fake version>: ArduinoJson (vendor/ArduinoJson) only enables its
# real-Arduino-String support (Writer<String>/Reader<String> specializations
# our String stub needs - see stubs/Arduino.h's concat()/length()) behind
# `#ifdef ARDUINO`, which the real Arduino build system defines and nothing
# here otherwise would. Its Stream/Print support rides the same #ifdef by
# default but is explicitly turned back off - we don't use either, and
# stubbing them (a real Stream/Print base class) isn't worth it for no gain.
CXXFLAGS = -std=c++17 -Wall -Wno-unused-function -Wno-unused-variable \
           -Wno-deprecated-declarations -Wno-format-security -Wno-deprecated \
           -DARDUINO=10812 -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
           -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 -DARDUINOJSON_ENABLE_ARDUINO_PRINT=0 \
           -DARDUINOJSON_ENABLE_PROGMEM=0 \
           -I stubs -I vendor/ArduinoJson -I ../lib/common -I . \
           $(SDL_CFLAGS)

# -lcurl: real HTTP requests against a local `wrangler dev` (stubs/HTTPClient.h).
# CommonCrypto (stubs/mbedtls/{sha256,md,gcm}.h) needs no extra link flag -
# part of libSystem. Security.framework (stubs/mbedtls/{ecp,ecdh}.h, for P-256
# ECDH - see root CLAUDE.md's encrypted-buckets plan) does need explicit
# framework linking, unlike CommonCrypto. HKDF has no mbedtls stub at all -
# device_app.h hand-rolls it from mbedtls_md's HMAC (see hkdfSha256()) since
# real hardware's mbedtls build doesn't link mbedtls_hkdf() either.
LDFLAGS = $(SDL_LIBS) -lcurl -framework Security -framework CoreFoundation

BOARD ?= ee02

ifeq ($(BOARD),ee02)
  BOARD_SRC_DIR = ../src/ee02
  BOARD_MAIN    = ../src/ee02/main.cpp
  SIM_MAC       = 020000000001
else ifeq ($(BOARD),ee04)
  BOARD_SRC_DIR = ../src/ee04
  BOARD_MAIN    = ../src/ee04/main.cpp
  SIM_MAC       = 020000000002
else
  $(error Unknown BOARD "$(BOARD)" - expected ee02 or ee04)
endif

# BOARD_MAIN_CPP: which real board main.cpp main_native.cpp #includes.
# SIM_STATE_DIR: per-board prefix for the actual on-disk state directory,
# .state/<SIM_STATE_DIR>-<build-uuid>/ (main_native.cpp's boardStateDir(),
# stubs/Preferences.h) - keeps ee02 and ee04 runs from ever sharing WiFi/
# secret/registration state, and (via the build-uuid suffix) keeps two
# instances of the SAME board from colliding either - see main_native.cpp's
# boardStateDir() doc comment.
# SIM_DEVICE_MAC_HEX: last-resort fallback MAC if stubs/WiFi.h's normal
# Mach-O-UUID-derived MAC (SimMac::buildMacAddress(), recomputed fresh each
# run - not persisted to disk) can't be computed for some reason.
BOARD_DEFINES = -DBOARD_MAIN_CPP='"$(BOARD_MAIN)"' \
                -DSIM_STATE_DIR='"$(BOARD)"' \
                -DSIM_DEVICE_MAC_HEX='"$(SIM_MAC)"'

# The board's own main.cpp is pulled in via #include inside main_native.cpp
# (see that file), NOT compiled separately here - it's the same file, and
# compiling it twice would double-define setup()/loop()/the board's globals.
SRCS = main_native.cpp \
       ../lib/common/ble_provisioning.cpp \
       ../lib/common/ota_health.cpp \
       ../lib/common/config_manager.cpp \
       ../lib/common/tinfl.c \
       gatt_bridge.cpp \
       display_render.cpp \
       $(BOARD_SRC_DIR)/display.cpp

.PHONY: all run test clean

all: sim-$(BOARD)

sim-$(BOARD): $(SRCS) $(wildcard stubs/*.h) $(wildcard stubs/mbedtls/*.h) gatt_bridge.h display_render.h
	$(CXX) $(CXXFLAGS) $(BOARD_DEFINES) $(SRCS) -o $@ $(LDFLAGS)

run-$(BOARD): sim-$(BOARD)
	./sim-$(BOARD)

# Native pipeline tests (tools/test_*.cpp against tools/gen_*_vectors.mjs
# fixtures) - see tools/run_native_tests.sh. `run` gates on these passing so
# a broken crypto/inflate pipeline is caught before the simulator ever boots,
# not discovered mid-session.
test:
	./tools/run_native_tests.sh

run: test all
	./sim-$(BOARD)

clean:
	rm -f sim-ee02 sim-ee04 tools/test_gcm_stream tools/test_tinfl_stream tools/test_decrypt_inflate_pipeline
