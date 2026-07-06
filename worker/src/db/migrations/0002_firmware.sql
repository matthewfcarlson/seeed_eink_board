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
