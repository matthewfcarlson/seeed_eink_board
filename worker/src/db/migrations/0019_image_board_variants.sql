-- Each image gets a packed+thumbnail variant per board (e.g. 'ee02-13in3',
-- 'ee04-7in3' - see lib/media-constants.ts's BoardId/BOARD_GEOMETRY) instead
-- of one fixed packing for the whole bucket. A bucket stays board-agnostic
-- (device_buckets was always many-to-many with no board constraint, and
-- stays that way) - any device subscribed to it is served whichever variant
-- matches its own X-Device-Board, so one bucket can mix EE02 and EE04
-- devices freely. The client (worker/src/client/admin.ts's confirmUpload/
-- reencryptOneImage) generates every board's variant on every upload -
-- there are only two boards today, so this is cheap and needs no "which
-- boards does this bucket need" selector.
CREATE TABLE image_variants (
  image_id        TEXT NOT NULL REFERENCES images(id),
  -- BoardId - not a foreign key, same reasoning as devices.board (migrations/
  -- 0012_device_board.sql): a fixed, small, code-defined vocabulary, not a
  -- separate lookup table.
  board           TEXT NOT NULL,
  packed_encoding TEXT NOT NULL DEFAULT 'identity',
  packed_hash     TEXT NOT NULL,
  packed_bytes    INTEGER NOT NULL,
  PRIMARY KEY (image_id, board)
);

-- Backfill: every image that already existed was packed under the only
-- geometry the pipeline supported before this migration.
INSERT INTO image_variants (image_id, board, packed_encoding, packed_hash, packed_bytes)
SELECT id, 'ee02-13in3', packed_encoding, packed_hash, packed_bytes FROM images;

-- These are now per-variant (image_variants above), not per-image - an
-- image with two boards' variants would otherwise have no single
-- packed_hash/packed_bytes/packed_encoding to hold here. images.key_version
-- stays: a rotation always re-derives and re-uploads every board's variant
-- for an image in one client call, so "which key version is this image's
-- raw + every variant currently under" is still meaningfully one value.
ALTER TABLE images DROP COLUMN packed_encoding;
ALTER TABLE images DROP COLUMN packed_hash;
ALTER TABLE images DROP COLUMN packed_bytes;
