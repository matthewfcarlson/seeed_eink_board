-- Public buckets: lets a superuser mark a bucket "public" so every signed-up
-- account can read (not write) it, without inventing a second storage/crypto
-- pipeline. See root CLAUDE.md's encrypted-buckets plan for the existing
-- per-principal ECIES-wrapped-key model this extends.
--
-- is_superuser has deliberately no API to set it — it's a manual operator
-- action. To grant it to a specific user id, run (per wrangler.toml's
-- database_name for each environment - "eink-local" for local dev,
-- "eink" for the real remote DB):
--   wrangler d1 execute eink-local --local  --command "UPDATE users SET is_superuser = 1 WHERE id = '<user-id>';"
--   wrangler d1 execute eink --remote --command "UPDATE users SET is_superuser = 1 WHERE id = '<user-id>';"
-- Find a user's id by inspecting the `users` table (there's no admin-facing
-- display of it today - GET /admin/me returns it as `id` for whoever's
-- currently logged in, if you'd rather query it that way).
ALTER TABLE users ADD COLUMN is_superuser INTEGER NOT NULL DEFAULT 0;

-- Whether this bucket is readable (never writable) by every account, not
-- just its owner/collaborators. Settable only by a superuser (enforced in
-- routes/admin/buckets.ts, not here - D1/SQLite has no per-column write ACL).
ALTER TABLE buckets ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;

-- The bucket's raw, UNWRAPPED AES-256-GCM content key, base64 - only ever
-- non-null when is_public = 1. This is the deliberate escape hatch from the
-- normal per-principal-wrapped-key model: ECIES wraps a key FOR a specific
-- recipient's public key, and there is no recipient public key for "anyone
-- with an account", so a public bucket's key simply isn't kept secret at
-- all. This is *not* a plaintext carve-out for the bucket's images/thumbs -
-- those stay exactly as AES-256-GCM-encrypted as any other bucket's, under
-- this same key. Every other part of the system (client encrypt-before-
-- upload, GCM tamper-detection on decrypt, firmware's decrypt-in-place) is
-- completely unaware this column exists: a device that gets this bucket's
-- key wrapped for it via /admin/devices/:mac/buckets (the wrap step reads the
-- raw key from here instead of from a personal bucket_keys row when the
-- caller isn't the owner) sees an ordinary ECIES-wrapped bucket_keys row,
-- indistinguishable from any other bucket's.
ALTER TABLE buckets ADD COLUMN public_key_raw TEXT;
