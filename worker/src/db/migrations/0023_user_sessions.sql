-- Per-login bearer-token sessions, replacing the single users.api_key_hash.
-- Before this, every passkey ceremony (and every "Rotate API key") overwrote
-- one column, so logging in from a second browser silently logged the first
-- one out, logout only cleared localStorage (the server-side hash stayed
-- valid forever), and no per-session revocation was possible. See
-- lib/auth-admin.ts and routes/admin/sessions.ts. Numbered 0023 because
-- 0022_random_rotation.sql (landed via the random-bucket-selection merge)
-- took 0022.
--
-- Breaking (intentional): users.api_key_hash is dropped and no migration path
-- backfills sessions from it — only hashes are stored, so old keys cannot be
-- converted. Every logged-in browser is logged out once at deploy and must
-- re-run a passkey ceremony. Acceptable while no devices have shipped (see
-- CLAUDE.md's "Known gaps"): this ships before any fleet exists to strand.
CREATE TABLE user_sessions (
  id            TEXT PRIMARY KEY,     -- random, NOT secret; identifies a session for revocation/listing
  user_id       TEXT NOT NULL REFERENCES users(id),
  -- SHA-256 of the bearer token, same scheme as the old api_key_hash — full-
  -- entropy random token, so a fast digest is fine (see lib/auth-admin.ts).
  token_hash    TEXT NOT NULL UNIQUE,
  -- Passkey credential that minted this session (registration or login).
  -- SET NULL on credential delete so dropping a credential doesn't cascade-
  -- delete the session history — the session itself is revoked via token, and
  -- deleting a credential should not silently kill unrelated sessions.
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  -- Throttled write (at most once/hour per session — see authenticateAdmin)
  -- so dashboard polling doesn't become a D1 write on every request.
  last_used_at  INTEGER,
  -- NULL = never expires in v1; revocation is explicit (logout / revoke).
  expires_at    INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_token ON user_sessions(token_hash);

ALTER TABLE users DROP COLUMN api_key_hash;
