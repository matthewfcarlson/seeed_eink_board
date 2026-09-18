-- Reference copy of the full schema. The authoritative, applied version lives in
-- migrations/0001_init.sql, 0002_firmware.sql, 0003_include_default_images.sql,
-- 0004_device_secret.sql, 0005_device_nonce.sql, 0006_running_firmware.sql,
-- 0007_buckets.sql, 0008_user_display_name.sql, 0009_bucket_ownership.sql,
-- 0010_remove_shared_targets.sql, 0011_crash_reports.sql, 0012_device_board.sql,
-- 0013_firmware_releases_board.sql, 0014_firmware_channel.sql,
-- 0015_bucket_encryption.sql, 0016_bucket_key_rotation.sql,
-- 0017_packed_encoding.sql, and 0018_public_buckets.sql (wrangler d1
-- migrations tracks applied state per-database).

-- No email/username — passkey registration (see routes/auth-passkey.ts) is the only
-- way to create a row here, and a passkey needs nothing but the credential itself.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  api_key_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Human-settable name shown instead of "Account <id prefix>" (see migrations/0008) —
  -- also how a user identifies themselves in a shared bucket's collaborator list.
  display_name  TEXT,
  -- P-256 public key, generated client-side at first passkey registration (see
  -- migrations/0015). The matching private key is never stored in the clear —
  -- see credentials.wrapped_sharing_key below.
  sharing_public_key TEXT,
  -- Manually flipped in D1 by the project owner (no API sets this - see
  -- migrations/0018_public_buckets.sql for the exact command). Gates only
  -- whether this account may mark a bucket it owns `is_public` - nothing else.
  is_superuser  INTEGER NOT NULL DEFAULT 0
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
  running_firmware_version   TEXT,
  -- Which board this device is (e.g. 'ee02-13in3', 'ee04-7in3'), self-reported
  -- via X-Device-Board the same way — see migrations/0012. NULL until a
  -- device's first successful request.
  board                       TEXT,
  -- P-256 public key, generated on-device at first boot and handed to the
  -- Worker at provisioning/claim time — see migrations/0015. Independent of
  -- `board`; the matching private key never leaves the device's NVS.
  sharing_public_key          TEXT
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
  created_at INTEGER NOT NULL,
  -- The bucket's current AES-256-GCM content-key version — see
  -- migrations/0016_bucket_key_rotation.sql. Bumped only by
  -- POST /admin/buckets/:id/rotate/:rotationId/finalize.
  key_version INTEGER NOT NULL DEFAULT 1,
  -- Public buckets (migrations/0018_public_buckets.sql): is_public makes this
  -- bucket readable (never writable) by every account, settable only by a
  -- superuser. public_key_raw is the bucket's raw, UNWRAPPED AES-256-GCM key
  -- (base64) - only ever non-null when is_public = 1. This is the deliberate
  -- escape hatch from the normal per-principal-ECIES-wrapped-key model above:
  -- there's no recipient public key for "anyone with an account" to wrap
  -- against, so a public bucket's key just isn't kept secret, while every
  -- image byte is still exactly as AES-256-GCM-encrypted under it as any
  -- other bucket's - the whole rest of the pipeline (client encrypt-before-
  -- upload, GCM tamper-detection, firmware decrypt) needs zero changes.
  is_public      INTEGER NOT NULL DEFAULT 0,
  public_key_raw TEXT
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

-- Pure key distribution (see migrations/0015) — deliberately separate from
-- bucket_shares/device_buckets above, which stay pure authorization tables.
-- One row per (bucket, principal, key_version) holding that principal's
-- ECIES-wrapped copy of the bucket's AES-256-GCM content-encryption key at
-- that version. ephemeral_pub/nonce/ciphertext are base64. key_version joined
-- the primary key in migrations/0016_bucket_key_rotation.sql so an old and a
-- new wrapped key can coexist for the same principal for the duration of a
-- rotation — see lib/bucket-keys.ts and routes/admin/buckets.ts's rotate/*
-- handlers. Looked up by principal (+ version) to answer "does this
-- user/device already have a usable key for this bucket at this version".
CREATE TABLE bucket_keys (
  bucket_id      TEXT NOT NULL REFERENCES buckets(id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'device')),
  principal_id   TEXT NOT NULL, -- users.id or devices.mac, depending on principal_type
  key_version    INTEGER NOT NULL DEFAULT 1,
  ephemeral_pub  TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  ciphertext     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, principal_type, principal_id, key_version)
);

-- One row tracks one bucket-key-rotation job (in progress or completed) — see
-- migrations/0016_bucket_key_rotation.sql and routes/admin/buckets.ts's
-- rotate/* handlers. Lets a client that closed its tab mid-rotation resume
-- via GET /admin/buckets/:id/rotate/status instead of starting a fresh
-- rotation (which would orphan whatever the abandoned job already
-- re-encrypted). At most one 'in_progress' row per bucket_id (enforced by a
-- partial unique index, not expressible as a plain column constraint here).
CREATE TABLE bucket_rotations (
  id               TEXT PRIMARY KEY,
  bucket_id        TEXT NOT NULL REFERENCES buckets(id),
  new_key_version  INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')) DEFAULT 'in_progress',
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_bucket_rotations_bucket_id ON bucket_rotations(bucket_id, created_at DESC);
CREATE UNIQUE INDEX idx_bucket_rotations_one_active ON bucket_rotations(bucket_id) WHERE status = 'in_progress';

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
  raw_bytes         INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  -- Which of the owning bucket's key versions this image's raw blob and
  -- every board variant's blobs are actually encrypted under right now (see
  -- migrations/0016_bucket_key_rotation.sql). A rotation re-derives and
  -- re-uploads every board's variant for an image in one client call, so
  -- this stays one per-image value rather than moving to image_variants
  -- alongside packed_hash/packed_bytes/packed_encoding below. Lags
  -- buckets.key_version between a rotation's start and this image's
  -- reencrypt-image call; equal to it once migrated.
  key_version       INTEGER NOT NULL DEFAULT 1,
  UNIQUE(device_key, filename)
);
CREATE INDEX idx_images_device_key_filename ON images(device_key, filename);

-- One packed+thumbnail variant per (image, board) - migrations/
-- 0019_image_board_variants.sql. See lib/media-constants.ts's BoardId; not a
-- foreign key, same reasoning as devices.board (a fixed, small, code-defined
-- vocabulary). The Worker never sees plaintext to re-render a variant later,
-- so the client (admin.ts's confirmUpload/reencryptOneImage) generates every
-- board's variant on every upload - there are only two boards today.
CREATE TABLE image_variants (
  image_id        TEXT NOT NULL REFERENCES images(id),
  board           TEXT NOT NULL,
  -- 'identity' or 'deflate-raw' - see migrations/0017_packed_encoding.sql
  -- and client/compress.ts. Describes the plaintext that was encrypted for
  -- THIS board's variant, never something the Worker can verify independently.
  packed_encoding TEXT NOT NULL DEFAULT 'identity',
  packed_hash     TEXT NOT NULL,
  packed_bytes    INTEGER NOT NULL,
  PRIMARY KEY (image_id, board)
);

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
  created_at  INTEGER NOT NULL,
  -- users.sharing_public_key's matching private key, AES-256-GCM-wrapped under a
  -- key derived from *this credential's* WebAuthn PRF output (see migrations/0015).
  -- Per-credential, not per-user: PRF output is scoped to the credential, so a
  -- user with multiple registered passkeys needs one wrapping per passkey. NULL
  -- when this credential's authenticator didn't return a PRF result at
  -- registration time (see lib/webauthn.ts's documented fallback).
  wrapped_sharing_key TEXT,
  wrap_nonce          TEXT
);
CREATE INDEX idx_credentials_user_id ON credentials(user_id);

-- Firmware OTA: releases Cloudflare has fetched from GitHub. Board-scoped
-- (migrations/0013) — two boards built from the same version tag are two
-- separate rows (different sha256/binary), not one. `board` values match
-- devices.board, the PlatformIO environment name, and the GitHub release
-- asset suffix (firmware-<board>.bin) — one board-id vocabulary used
-- everywhere.
CREATE TABLE firmware_releases (
  board       TEXT NOT NULL,   -- e.g. 'ee02-13in3', 'ee04-7in3'
  version     TEXT NOT NULL,   -- e.g. "1.2.0" (tag_name with leading 'v' stripped)
  tag         TEXT NOT NULL,   -- raw GitHub tag_name, e.g. "v1.2.0"
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  source_url  TEXT NOT NULL,   -- GitHub release asset download URL, for reference/debugging
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (board, version)
);

-- Which channel each device (mac only, no shared 'default'/'global' target —
-- see schedule_overrides above for the matching rationale) tracks, rather
-- than an admin-picked exact version (migrations/0014 removed that). No
-- `board`/`version`/FK here — see lib/firmware-target.ts's resolveFirmwareTarget:
-- 'stable' always resolves to the newest firmware_releases row for whatever
-- board the device reports on that request (via X-Device-Board), so there's
-- no fixed release row to reference. 'beta' currently resolves to nothing
-- (no beta pipeline exists yet) — same as no row at all.
CREATE TABLE firmware_targets (
  target      TEXT PRIMARY KEY, -- mac, owned via devices.user_id
  channel     TEXT NOT NULL,    -- 'stable' | 'beta'
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
