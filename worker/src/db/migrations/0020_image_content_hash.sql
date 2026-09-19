-- Duplicate detection for uploads (admin/images/upload's 409 path). Every
-- upload may carry a `content_hash` form field: a 16-hex-char HMAC-SHA256,
-- keyed with a bucket-key-derived hash key (client/crypto.ts's
-- computeContentHash), over the DEFAULT board's plaintext packed buffer —
-- computed client-side BEFORE compression/encryption, so identical
-- renditions of the same photo collide regardless of source-file format or
-- filename (the existing packed_hash is over the *ciphertext*, whose random
-- nonce makes it differ on every upload, so it can't serve this purpose).
--
-- Keying with the bucket key means the Worker can only ever compare hashes
-- within one bucket: it can't correlate identical images across buckets,
-- and there's no global plaintext-derived hash table to attack. Like
-- dither_algorithm/packed_hash, the Worker can't verify the value without
-- the bucket key — this is a courtesy check, not a security boundary (the
-- client can always pass ?allow_duplicate=1).
--
-- Bucket-key rotation recomputes every image's hash under the NEW key
-- (client/admin.ts's reencryptOneImage sends it via reencrypt-image, which
-- re-derives the packed pixels anyway), so hashes stay comparable across a
-- completed rotation. NULL for images predating this migration or uploaded
-- by a client that didn't send one — dedupe simply doesn't apply to those.
ALTER TABLE images ADD COLUMN content_hash TEXT;

-- Lookup key for the upload route's duplicate check: one bucket, one hash.
CREATE INDEX idx_images_device_key_hash ON images(device_key, content_hash);
