-- last_signature_timestamp was fed from the ESP32's time(nullptr), which
-- doesn't survive a real power loss (only deep sleep keeps the RTC running) —
-- a device that ever browns out then sends a "timestamp" behind what's already
-- on file and gets permanently 401'd. Replaced with an opaque monotonic nonce
-- the firmware persists in NVS instead (ConfigManager::nextNonce()), which only
-- ever goes up regardless of wall-clock state. See lib/device-signature.ts.
ALTER TABLE devices RENAME COLUMN last_signature_timestamp TO last_nonce;

-- Any value already in this column is an epoch-scale timestamp (~1.7 billion),
-- meaningless as a starting point for the new counter — the firmware's NVS
-- counter starts back at 1, which would be "less than" that leftover value and
-- get rejected as a replay forever. Reset the cutover point to 0 for everyone.
UPDATE devices SET last_nonce = 0;
