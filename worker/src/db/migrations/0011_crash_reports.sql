-- Crash/rollback reports uploaded by firmware/src/ota_health.cpp + main.cpp's
-- sendCrashReportIfPending(), via POST /crash_report. Populated when a device
-- panics/watchdog-resets, or when an OTA gets rolled back (bootloader-automatic,
-- after a boot-time crash on the pending version; or app-forced, after
-- OTA_MAX_UNCONFIRMED_BOOT_ATTEMPTS wake cycles without confirming itself
-- healthy) - see CLAUDE.md's OTA section. Pruned to the most recent 20 rows per
-- device by routes/crash-report.ts on every insert; otherwise read-only.
CREATE TABLE crash_reports (
  id                   TEXT PRIMARY KEY,
  device_mac           TEXT NOT NULL REFERENCES devices(mac),
  -- Version that actually experienced the failure - for a rollback this is the
  -- version being rolled back *away from*, not whatever's running now.
  firmware_version     TEXT NOT NULL,
  rolled_back          INTEGER NOT NULL DEFAULT 0,
  reset_reason         TEXT NOT NULL, -- esp_reset_reason(), e.g. "panic", "task_wdt", "brownout", "sw"
  boot_attempts        INTEGER NOT NULL DEFAULT 0,
  -- Populated only when a core dump was present in flash (see esp_core_dump_get_summary()) -
  -- null for a functional-failure rollback with no actual crash.
  crash_task           TEXT,
  crash_pc             TEXT,    -- hex PC, e.g. "0x420182a0"
  crash_cause          INTEGER,
  backtrace            TEXT,    -- JSON array of hex PC strings, or null
  backtrace_corrupted  INTEGER,
  received_at          INTEGER NOT NULL
);
CREATE INDEX idx_crash_reports_device_mac ON crash_reports(device_mac, received_at DESC);
