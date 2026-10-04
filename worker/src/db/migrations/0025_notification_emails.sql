-- Email as a device-alert channel, alongside 0024's webhooks. Sent via
-- Cloudflare Email Service's `send_email` binding (see lib/email-alerts.ts).
--
-- This is the first column in the schema holding a user's personal contact
-- info (accounts are otherwise passkey-only — see 0023). Kept minimal: only
-- what's needed to deliver, and the row is deleted outright — not flagged —
-- on removal or unsubscribe.
CREATE TABLE notification_emails (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  email             TEXT NOT NULL, -- trimmed + lowercased
  -- NULL until the recipient clicks the confirmation link. Nothing but the
  -- confirmation email itself is ever sent to an unverified address, so
  -- nobody can point alerts at someone else's inbox.
  verified_at       INTEGER,
  -- SHA-256 hex of the one-time confirmation token (the raw token only ever
  -- exists in the emailed link); cleared on verification.
  verify_token_hash TEXT,
  verify_sent_at    INTEGER,
  -- Random, embedded in every alert's unsubscribe link/List-Unsubscribe
  -- header. Stored raw (it has to go into every email); the worst a leak
  -- allows is unsubscribing that address.
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  last_attempt_at   INTEGER,
  last_error        TEXT,
  UNIQUE (user_id, email)
);
CREATE INDEX idx_notification_emails_user ON notification_emails(user_id);
CREATE INDEX idx_notification_emails_verify ON notification_emails(verify_token_hash);
