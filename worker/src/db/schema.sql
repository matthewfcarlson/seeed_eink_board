-- Reference copy of the full schema. The authoritative, applied version lives in
-- migrations/0001_init.sql, 0002_firmware.sql, 0003_include_default_images.sql,
-- 0004_device_secret.sql, and 0005_device_nonce.sql (wrangler d1 migrations
-- tracks applied state per-database).

-- No email/username — passkey registration (see routes/auth-passkey.ts) is the only
-- way to create a row here, and a passkey needs nothing but the credential itself.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  api_key_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE devices (
  mac                     TEXT PRIMARY KEY,
  user_id                 TEXT REFERENCES users(id),
  label                   TEXT,
  created_at              INTEGER NOT NULL,
  last_seen_at            INTEGER,
  last_seen_ip            TEXT,
  last_battery_voltage    REAL,
  last_battery_at         INTEGER,
  -- Whether this device's rotation merges in the shared 'default' bucket's
  -- images alongside its own. Defaults to on (see migrations/0003).
  include_default_images  INTEGER NOT NULL DEFAULT 1,
  -- Per-device HMAC secret (hex), minted on-device and delivered out-of-band via
  -- the registration QR code. NULL means "not registered" for auth purposes even
  -- if a row exists — see migrations/0004 and lib/device-signature.ts.
  secret       TEXT,
  -- Opaque monotonic anti-replay counter, NVS-persisted on the device (not a
  -- timestamp — see migrations/0005). Reset to 0 whenever `secret` changes.
  last_nonce   INTEGER NOT NULL DEFAULT 0
);

-- Durable mirror of the live rotation cursor. KV is the hot path; this table is
-- written async (ctx.waitUntil) and used for recovery + the /current status view.
CREATE TABLE rotation_state (
  device_key    TEXT PRIMARY KEY, -- mac, or the literal string 'default'
  current_index INTEGER NOT NULL DEFAULT 0,
  last_returned TEXT,
  updated_at    INTEGER NOT NULL
);

-- Catalog of processed images per device bucket. Rotation order is
-- `ORDER BY filename ASC`, computed once here rather than re-listing KV per request.
-- The actual image bytes live in KV under deterministic keys derived from
-- (device_key, id) — see lib/image-store.ts — not stored as columns here.
CREATE TABLE images (
  id                TEXT PRIMARY KEY,
  device_key        TEXT NOT NULL,
  filename          TEXT NOT NULL,
  dither_algorithm  TEXT NOT NULL DEFAULT 'floyd_steinberg',
  packed_hash       TEXT NOT NULL,
  packed_bytes      INTEGER NOT NULL,
  raw_bytes         INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE(device_key, filename)
);
CREATE INDEX idx_images_device_key_filename ON images(device_key, filename);

-- Two-tier schedule override fallback: exact mac -> 'global'.
CREATE TABLE schedule_overrides (
  target                    TEXT PRIMARY KEY, -- mac | 'global'
  refresh_interval_minutes  INTEGER,
  active_start_hour         INTEGER,
  active_end_hour           INTEGER,
  timezone_offset_minutes   INTEGER,
  updated_at                INTEGER NOT NULL
);

-- Passkey (WebAuthn) credentials. Account creation requires registering one of
-- these — see routes/auth-passkey.ts — there is no other way to create a user.
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY, -- base64url credential ID from the authenticator
  user_id     TEXT NOT NULL REFERENCES users(id),
  public_key  TEXT NOT NULL,    -- base64url-encoded COSE public key
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,             -- JSON array of AuthenticatorTransportFuture, or null
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_credentials_user_id ON credentials(user_id);

-- Firmware OTA: releases Cloudflare has fetched from GitHub, and which version
-- each target (mac | 'default' | 'global') should be running. Mirrors the
-- schedule_overrides fallback-chain pattern in lib/schedule.ts.
CREATE TABLE firmware_releases (
  version     TEXT PRIMARY KEY, -- e.g. "1.2.0" (tag_name with leading 'v' stripped)
  tag         TEXT NOT NULL,    -- raw GitHub tag_name, e.g. "v1.2.0"
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  source_url  TEXT NOT NULL,    -- GitHub release asset download URL, for reference/debugging
  created_at  INTEGER NOT NULL
);

CREATE TABLE firmware_targets (
  target      TEXT PRIMARY KEY, -- mac | 'default' | 'global'
  version     TEXT NOT NULL REFERENCES firmware_releases(version),
  updated_at  INTEGER NOT NULL
);
