-- The 'default' bucket (migrations/0007_buckets.sql) was a globally-shared,
-- ownerless bucket every authenticated user could read/write/delete — a real
-- privacy leak once more than one user exists (see privacy review, 2026-07-07).
-- Production's copy has already been reassigned to its real owner via a one-off
-- UPDATE (the user whose device was actually subscribed to it) before this
-- migration runs. This migration removes any bucket that's still ownerless (a
-- fresh database's untouched 'default' seed row from 0007 — never has images or
-- subscribers at migration time, so this is a no-op data-wise there).
--
-- owner_id stays nullable at the schema level: D1's remote engine rejects
-- PRAGMA defer_foreign_keys mid-migration (tested — rolls back with a FOREIGN
-- KEY constraint error), which rules out the usual SQLite rebuild-the-table
-- recipe for adding a NOT NULL constraint here without dropping and recreating
-- device_buckets/bucket_shares/bucket_invites too. Enforcement is at the
-- application layer instead: POST /admin/buckets is the only INSERT into this
-- table (routes/admin/buckets.ts) and always supplies the caller's user id, and
-- lib/bucket-access.ts no longer special-cases a NULL/'default' owner as
-- universally accessible.
DELETE FROM images WHERE device_key IN (SELECT id FROM buckets WHERE owner_id IS NULL);
DELETE FROM device_buckets WHERE bucket_id IN (SELECT id FROM buckets WHERE owner_id IS NULL);
DELETE FROM bucket_shares WHERE bucket_id IN (SELECT id FROM buckets WHERE owner_id IS NULL);
DELETE FROM bucket_invites WHERE bucket_id IN (SELECT id FROM buckets WHERE owner_id IS NULL);
DELETE FROM buckets WHERE owner_id IS NULL;
