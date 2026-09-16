-- Client-side (E2E) encrypted image buckets — see plan §Data model changes.
-- Every principal (user, device) gets a P-256 keypair; the public half is safe
-- to store here freely, the private half never is. A user's sharing private
-- key is protected client-side by their passkey's WebAuthn PRF output and
-- stored wrapped, per-credential (PRF is scoped to the credential, not the
-- account) — see lib/webauthn.ts.

ALTER TABLE users ADD COLUMN sharing_public_key TEXT;

ALTER TABLE credentials ADD COLUMN wrapped_sharing_key TEXT;
ALTER TABLE credentials ADD COLUMN wrap_nonce TEXT;

-- Populated at provisioning/claim time from the device's own on-device keypair
-- (generated on first boot, private key never leaves NVS). Independent of
-- `board` (migrations 0012/0013) — board is a display-geometry/firmware
-- attribute, not an identity one.
ALTER TABLE devices ADD COLUMN sharing_public_key TEXT;

-- Pure key distribution, deliberately separate from bucket_shares/device_buckets
-- (which stay pure authorization tables, unchanged by this migration): one row
-- per (bucket, principal) holding that principal's ECIES-wrapped copy of the
-- bucket's AES-256-GCM key. ephemeral_pub/nonce/ciphertext are base64.
CREATE TABLE bucket_keys (
  bucket_id      TEXT NOT NULL REFERENCES buckets(id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'device')),
  principal_id   TEXT NOT NULL, -- users.id or devices.mac, depending on principal_type
  ephemeral_pub  TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  ciphertext     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, principal_type, principal_id)
);
