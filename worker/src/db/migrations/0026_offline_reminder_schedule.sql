-- "Still offline" reminder pacing moves from a per-device KV key (armed with
-- a TTL, its expiry meaning "due") to this column. The KV version cost one KV
-- read per alerted-offline device on every hourly run, forever — abandoned
-- frames accumulate, and a Worker invocation gets only 1,000 KV operations,
-- so the health check would eventually fail outright. As a column, "is a
-- reminder due?" is part of the candidate query in lib/health-check.ts and
-- costs nothing per device. NULL on an alerted device counts as due (so any
-- device alerted before this migration gets one reminder, then the normal
-- weekly/monthly cadence). Cleared on recovery.
ALTER TABLE devices ADD COLUMN next_reminder_at INTEGER;
