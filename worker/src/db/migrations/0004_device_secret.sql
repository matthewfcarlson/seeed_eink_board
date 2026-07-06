-- Per-device secret (hex string), minted on-device and delivered out-of-band via
-- the registration QR code shown on the physical display. Requests for a mac with
-- a non-null secret MUST carry a valid HMAC signature (see lib/device-signature.ts)
-- or they're rejected — closes the "just spoof X-Device-MAC" hole. Existing rows
-- get secret = NULL, which resolveDeviceKey() treats the same as unregistered,
-- forcing every already-claimed device through the QR flow once more to pick up a
-- secret.
ALTER TABLE devices ADD COLUMN secret TEXT;

-- Monotonic replay guard: a signed request must use a timestamp >= this value.
-- Deliberately not a wall-clock freshness check (>=, not "within N seconds") since
-- the ESP32's clock may not be NTP-accurate — only required to never go backwards,
-- which real device requests never do (RTC keeps ticking across deep sleep).
ALTER TABLE devices ADD COLUMN last_signature_timestamp INTEGER NOT NULL DEFAULT 0;
