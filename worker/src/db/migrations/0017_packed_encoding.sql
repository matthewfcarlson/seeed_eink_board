-- Packed-blob compression for encrypted image buckets - see root CLAUDE.md's
-- "Encrypted Image Buckets" plan. Compression has to happen client-side, on
-- the plaintext, before AES-256-GCM encryption (ciphertext itself doesn't
-- compress meaningfully) - see client/compress.ts and client/admin.ts's
-- uploadImage(). This column just records which form was actually uploaded,
-- so image-packed.ts can tell the device which decode path to use
-- (X-Packed-Encoding response header) and firmware's fetchAndDisplayImage()
-- knows whether to stream ciphertext straight into the display buffer
-- (identity, unchanged) or decrypt+inflate it chunk-by-chunk (deflate-raw).
ALTER TABLE images ADD COLUMN packed_encoding TEXT NOT NULL DEFAULT 'identity';
