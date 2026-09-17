-- Bucket key rotation — closes the "no crypto-level revocation" gap noted in
-- root CLAUDE.md's encrypted-buckets plan: deleting a bucket_shares/
-- device_buckets row today only blocks *new* access, since anyone who
-- already unwrapped the bucket's key keeps it forever. Rotation generates a
-- new key, re-encrypts every image under it, then re-wraps the new key only
-- for the currently-authorized principals and deletes the old-version wraps
-- — that delete is the actual revocation.

-- Which key version a bucket's *current* content key is at. Bumped only by
-- POST /admin/buckets/:id/rotate/:rotationId/finalize, once every image is
-- confirmed re-encrypted and every live principal has a new-version wrap.
ALTER TABLE buckets ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;

-- Which key version a given image's three KV blobs (raw/packed/thumb) are
-- actually encrypted under right now. Lags buckets.key_version between a
-- rotation's start and the moment each image is re-encrypted via
-- POST /admin/buckets/:id/rotate/:rotationId/reencrypt-image/:imageId.
ALTER TABLE images ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;

-- bucket_keys' primary key widens to include key_version so an old and a new
-- wrapped key can coexist for the same principal for the duration of a
-- rotation (the principal needs the OLD key until every image is migrated,
-- and the NEW key is wrapped for them as of rotate/start or rotate/finalize
-- — see routes/admin/buckets.ts). SQLite/D1 can't ALTER a table's PRIMARY
-- KEY in place, so this recreates the table — same recipe as
-- migrations/0009_bucket_ownership.sql and
-- migrations/0013_firmware_releases_board.sql. Every existing row is a
-- version-1 key (the only version that has ever existed before this
-- migration).
CREATE TABLE bucket_keys_new (
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

INSERT INTO bucket_keys_new (bucket_id, principal_type, principal_id, key_version, ephemeral_pub, nonce, ciphertext, created_at)
  SELECT bucket_id, principal_type, principal_id, 1, ephemeral_pub, nonce, ciphertext, created_at FROM bucket_keys;

DROP TABLE bucket_keys;
ALTER TABLE bucket_keys_new RENAME TO bucket_keys;

-- One row tracks one rotation job per bucket — lets a client that closed its
-- tab mid-rotation resume via GET /admin/buckets/:id/rotate/status instead of
-- starting over (which would mean generating yet another key version and
-- orphaning whatever the abandoned job already re-encrypted under the
-- previous new_key_version). `status` moves from 'in_progress' to
-- 'completed' at finalize; rows are kept (not deleted) as a small audit
-- trail, same "keep, don't delete" preference as crash_reports.
CREATE TABLE bucket_rotations (
  id               TEXT PRIMARY KEY,
  bucket_id        TEXT NOT NULL REFERENCES buckets(id),
  new_key_version  INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')) DEFAULT 'in_progress',
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_bucket_rotations_bucket_id ON bucket_rotations(bucket_id, created_at DESC);
-- At most one in-progress rotation per bucket at a time — rotate/start relies
-- on this to fail closed (via a UNIQUE constraint error) if two browser tabs
-- both race to start one, rather than silently minting two different
-- new_key_version=N keys for the same bucket.
CREATE UNIQUE INDEX idx_bucket_rotations_one_active ON bucket_rotations(bucket_id) WHERE status = 'in_progress';
