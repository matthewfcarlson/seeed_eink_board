-- Account recovery code: users.sharing_public_key's matching private key,
-- AES-256-GCM-wrapped under a key HKDF'd from a random 160-bit code the user
-- copies somewhere safe (client/crypto.ts's deriveKekFromRecoveryCode). Same
-- plaintext and wrap shape as credentials.wrapped_sharing_key, but per-user
-- rather than per-credential, and independent of WebAuthn PRF — so a browser
-- whose passkey can't produce a usable PRF result (or a user who lost their
-- passkey's PRF wrap) can still unlock. The Worker never sees the code and
-- can't decrypt this. One code per account: generating a new one replaces it
-- (routes/admin/auth.ts's PUT /admin/me/recovery-wrap, which requires proof
-- the caller holds the sharing private key — lib/sharing-key-proof.ts).
ALTER TABLE users ADD COLUMN recovery_wrapped_sharing_key TEXT;
ALTER TABLE users ADD COLUMN recovery_wrap_nonce TEXT;
ALTER TABLE users ADD COLUMN recovery_created_at INTEGER;
