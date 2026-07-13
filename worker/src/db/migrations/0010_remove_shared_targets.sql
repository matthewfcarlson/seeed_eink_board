-- schedule_overrides and firmware_targets both had a shared 'default'/'global'
-- tier that any authenticated user could read and write, regardless of whether
-- they owned any devices (routes/admin/schedule.ts and routes/admin/firmware.ts's
-- assertTargetOwnership special-cased those two literal strings as universally
-- accessible). For firmware in particular this meant any signed-up stranger
-- could force every device on the server to OTA-flash an arbitrary cataloged
-- version — this board has no rollback-on-crash, so a bad flash bricks it until
-- physically reflashed over USB. See privacy review, 2026-07-13.
--
-- Fix is app-layer (lib/schedule.ts, lib/firmware-target.ts, and both admin
-- routes' assertTargetOwnership no longer special-case these strings — every
-- target must now be a device MAC owned by the caller). This migration carries
-- forward the *effective* config each device was already inheriting through the
-- old shared tier into a real per-device row, so removing the shared tier
-- doesn't silently change any device's runtime behavior — only who's allowed to
-- change it going forward. A device that already has its own override keeps it
-- unchanged (it always won over the shared tier anyway). Old schedule_overrides
-- never had a 'default' tier (see lib/schedule.ts's prior chain), only 'global';
-- firmware_targets' chain was device -> 'default' -> 'global', so 'default' wins
-- when both exist.
INSERT INTO schedule_overrides (target, refresh_interval_minutes, active_start_hour, active_end_hour, timezone_offset_minutes, updated_at)
SELECT d.mac, g.refresh_interval_minutes, g.active_start_hour, g.active_end_hour, g.timezone_offset_minutes, g.updated_at
FROM devices d, schedule_overrides g
WHERE g.target = 'global'
  AND NOT EXISTS (SELECT 1 FROM schedule_overrides ex WHERE ex.target = d.mac);

INSERT INTO firmware_targets (target, version, updated_at)
SELECT d.mac, COALESCE(fd.version, fg.version), COALESCE(fd.updated_at, fg.updated_at)
FROM devices d
LEFT JOIN firmware_targets fd ON fd.target = 'default'
LEFT JOIN firmware_targets fg ON fg.target = 'global'
WHERE COALESCE(fd.version, fg.version) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM firmware_targets ex WHERE ex.target = d.mac);

DELETE FROM schedule_overrides WHERE target NOT IN (SELECT mac FROM devices);
DELETE FROM firmware_targets WHERE target NOT IN (SELECT mac FROM devices);
