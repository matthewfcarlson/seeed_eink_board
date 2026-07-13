-- Reference copy of the full schema. The authoritative, applied version lives in
-- migrations/0001_init.sql, 0002_firmware.sql, 0003_include_default_images.sql,
-- 0004_device_secret.sql, 0005_device_nonce.sql, 0006_running_firmware.sql,
-- 0007_buckets.sql, 0008_user_display_name.sql, 0009_bucket_ownership.sql,
-- 0010_remove_shared_targets.sql, and 0011_crash_reports.sql (wrangler d1
-- migrations tracks applied state per-database).

-- No email/username — passkey registration (see routes/auth-passkey.ts) is the only
-- way to create a row here, and a passkey needs nothing but the credential itself.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  api_key_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Human-settable name shown instead of "Account <id prefix>" (see migrations/0008) —
  -- also how a user identifies themselves in a shared bucket's collaborator list.
  display_name  TEXT
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
  -- Per-device HMAC secret (hex), minted on-device and delivered out-of-band via
  -- the registration QR code. NULL means "not registered" for auth purposes even
  -- if a row exists — see migrations/0004 and lib/device-signature.ts.
  secret       TEXT,
  -- Opaque monotonic anti-replay counter, NVS-persisted on the device (not a
  -- timestamp — see migrations/0005). Reset to 0 whenever `secret` changes.
  last_nonce   INTEGER NOT NULL DEFAULT 0,
  -- Version this device last reported running, via X-Firmware-Version on every
  -- request — distinct from firmware_targets, which is the desired version.
  running_firmware_version   TEXT
);

-- Image buckets: independently-owned, shareable entities a device subscribes to
-- many-to-many (see migrations/0007). There is no globally-shared bucket —
-- every bucket belongs to exactly one user and everyone else needs an accepted
-- invite (bucket_shares) to see it (migrations/0009 removed the old ownerless
-- 'default' bucket). owner_id stays nullable at the schema level only because
-- D1's remote engine won't allow the usual SQLite table-rebuild recipe for
-- adding NOT NULL here (see migrations/0009's comment) — it's enforced instead
-- by lib/bucket-access.ts (a NULL owner matches no one) and by
-- routes/admin/buckets.ts being the only INSERT path, which always supplies
-- the caller's user id.
CREATE TABLE buckets (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT REFERENCES users(id),
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE device_buckets (
  device_mac TEXT NOT NULL REFERENCES devices(mac),
  bucket_id  TEXT NOT NULL REFERENCES buckets(id),
  PRIMARY KEY (device_mac, bucket_id)
);

-- Full read/write collaborators on a bucket, not the owner.
CREATE TABLE bucket_shares (
  bucket_id  TEXT NOT NULL REFERENCES buckets(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, user_id)
);

-- One reusable-until-revoked invite link per bucket.
CREATE TABLE bucket_invites (
  bucket_id  TEXT PRIMARY KEY REFERENCES buckets(id),
  token      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
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

-- Per-device schedule override, or nothing (firmware runs on its own compiled-in
-- default). No shared 'global'/'default' fallback row (removed in migrations/
-- 0010_remove_shared_targets.sql) — that was a Worker-only addition on top of
-- image_server.py, and letting any authenticated user write one row every other
-- tenant's un-configured devices inherited was a cross-tenant griefing vector.
CREATE TABLE schedule_overrides (
  target                    TEXT PRIMARY KEY, -- mac, owned via devices.user_id
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
-- each device (mac only, no shared 'default'/'global' target — see
-- schedule_overrides above for the matching rationale) should be running.
CREATE TABLE firmware_releases (
  version     TEXT PRIMARY KEY, -- e.g. "1.2.0" (tag_name with leading 'v' stripped)
  tag         TEXT NOT NULL,    -- raw GitHub tag_name, e.g. "v1.2.0"
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  source_url  TEXT NOT NULL,    -- GitHub release asset download URL, for reference/debugging
  created_at  INTEGER NOT NULL
);

CREATE TABLE firmware_targets (
  target      TEXT PRIMARY KEY, -- mac, owned via devices.user_id
  version     TEXT NOT NULL REFERENCES firmware_releases(version),
  updated_at  INTEGER NOT NULL
);

-- Crash/rollback reports uploaded by firmware/src/ota_health.cpp + main.cpp's
-- sendCrashReportIfPending(), via POST /crash_report — see migrations/0011.
-- Pruned to the most recent 20 rows per device on every insert.
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
