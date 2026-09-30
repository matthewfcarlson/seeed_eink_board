-- Device health alerts: tell an owner when a frame stops checking in or its
-- battery runs low, via webhooks they register themselves. Accounts have no
-- email/phone on file (passkey-only — see migrations/0023_user_sessions.sql),
-- so a user-supplied URL is the first delivery channel that needs no new
-- personal data. See lib/device-health.ts (detection), lib/notify.ts
-- (delivery), routes/admin/notifications.ts (CRUD), index.ts's scheduled().

CREATE TABLE notification_webhooks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  -- https-only. Slack/Discord URLs embed their own bearer token, so this is
  -- treated as a secret: the admin API only ever returns a masked preview.
  url             TEXT NOT NULL,
  -- Payload shape — see lib/notify.ts's buildWebhookRequest.
  format          TEXT NOT NULL CHECK (format IN ('json', 'slack', 'discord', 'ntfy')),
  label           TEXT,
  -- HMAC-SHA256 key (hex) for the `json` format's X-Eink-Signature header, so
  -- a receiver can tell our POSTs from anyone else who learns the URL.
  -- Generated server-side for every format (cheap, and switching format
  -- later never needs a backfill); only shown to the user once, at creation.
  signing_secret  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  -- Outcome of the most recent delivery attempt, for the admin UI. Status 0 =
  -- network error/timeout (no HTTP response at all).
  last_attempt_at INTEGER,
  last_status     INTEGER,
  last_error      TEXT
);
CREATE INDEX idx_notification_webhooks_user ON notification_webhooks(user_id);

-- Per-device alert state: non-NULL = "we already told the owner about this"
-- (the epoch it fired). The hourly check alerts on transitions — once when a
-- device goes offline/low, once when it recovers — plus "still offline"
-- reminders paced by a KV TTL (weekly, then monthly), never every hour.
ALTER TABLE devices ADD COLUMN offline_alerted_at INTEGER;
ALTER TABLE devices ADD COLUMN low_battery_alerted_at INTEGER;
-- Owner opted this device out of alerts (e.g. unplugged on purpose). Muted
-- devices are skipped entirely; their alert state freezes until unmuted.
ALTER TABLE devices ADD COLUMN alerts_muted INTEGER NOT NULL DEFAULT 0;
