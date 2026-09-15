-- Replaces per-device exact firmware version pinning with a two-value
-- channel choice: 'stable' (always resolves to the newest cataloged
-- firmware_releases row for that device's own board — see
-- lib/firmware-target.ts) or 'beta' (no beta pipeline exists yet, so this
-- currently resolves to nothing, same as no target set at all - never
-- touches the device's firmware). No more admin-picked exact versions, and
-- no more per-target `board`/`version` columns — board is resolved fresh
-- from the device's own X-Device-Board header on every request, not stored
-- redundantly here, and there's no longer a specific release row to pin to
-- or foreign-key against.
--
-- Existing rows (if any) had already opted in to SOME version being pushed,
-- so they're carried forward onto 'stable' rather than silently dropped.

CREATE TABLE firmware_targets_new (
  target      TEXT PRIMARY KEY, -- mac, owned via devices.user_id
  channel     TEXT NOT NULL CHECK (channel IN ('stable', 'beta')),
  updated_at  INTEGER NOT NULL
);

INSERT INTO firmware_targets_new (target, channel, updated_at)
  SELECT target, 'stable', updated_at FROM firmware_targets;

DROP TABLE firmware_targets;
ALTER TABLE firmware_targets_new RENAME TO firmware_targets;
