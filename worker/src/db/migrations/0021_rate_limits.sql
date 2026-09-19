-- Fixed-window API rate limiting (see lib/rate-limit.ts). One row per
-- (limiter name, identity, window start) with a running counter; the window
-- start is embedded in the key so expired windows are just stale rows that
-- cleanup deletes opportunistically (same pattern as lib/schedule.ts's
-- NONE_SENTINEL rows living in KV — no TTL infrastructure needed in D1).
-- Deliberately no foreign keys: identities are IPs, MACs, or user ids.
CREATE TABLE rate_limits (
  key   TEXT PRIMARY KEY, -- "<name>:<identity>:<window_start>"
  count INTEGER NOT NULL
);
