-- Image buckets become first-class, independently-owned, shareable entities
-- instead of an implicit 1:1 with a device's mac plus a single hardcoded
-- 'default' bucket toggle. See plan: image buckets as shareable entities.

CREATE TABLE buckets (
  id         TEXT PRIMARY KEY,              -- crypto.randomUUID(), matches images.id/users.id convention
  owner_id   TEXT REFERENCES users(id),     -- NULL only for the one shared 'default' bucket
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE device_buckets (
  device_mac TEXT NOT NULL REFERENCES devices(mac),
  bucket_id  TEXT NOT NULL REFERENCES buckets(id),
  PRIMARY KEY (device_mac, bucket_id)
);

-- Full read/write collaborators, not the owner.
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

-- Backfill: existing data keeps working with zero KV/image movement, since
-- images.device_key values are already the right bucket ids.
INSERT INTO buckets (id, owner_id, label, created_at)
  VALUES ('default', NULL, 'Default (shared)', unixepoch());

INSERT INTO buckets (id, owner_id, label, created_at)
  SELECT mac, user_id, COALESCE(label, mac) || '''s images', created_at FROM devices;

INSERT INTO device_buckets (device_mac, bucket_id)
  SELECT mac, mac FROM devices;

INSERT INTO device_buckets (device_mac, bucket_id)
  SELECT mac, 'default' FROM devices WHERE include_default_images = 1;

ALTER TABLE devices DROP COLUMN include_default_images;
