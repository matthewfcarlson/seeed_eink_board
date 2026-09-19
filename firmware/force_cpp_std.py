"""Force C++17 for all PlatformIO environments.

The espressif32 platform hardcodes `-std=gnu++11` for Arduino-ESP32 core 2.x
and appends it to CXXFLAGS *after* anything from build_flags, and with GCC
the last `-std=` flag wins — so `-std=gnu++17` in build_flags alone is
silently overridden (seen as the "inline variables are only available with
-std=c++17" warning on lib/common/eink_text_display.h). This post script
strips every `-std=` flag the platform/framework setup added and appends the
project's chosen standard last.

lib/common/eink_text_display.h uses `inline constexpr` variables, which need
C++17. GCC 8.4 (the ESP32 toolchain here) supports C++17 fine; the core's
precompiled IDF components are unaffected by the user-code standard.
"""
from SCons.Script import Import  # noqa: I100

Import("env")

_CPP_STD = "-std=gnu++17"

for flag_key in ("CXXFLAGS", "CFLAGS", "CCFLAGS"):
    flags = env.get(flag_key, [])
    if any(str(f).startswith("-std") for f in flags):
        env[flag_key] = [f for f in flags if not str(f).startswith("-std")]

env.Append(CXXFLAGS=[_CPP_STD])
