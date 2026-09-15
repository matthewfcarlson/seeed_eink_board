-- Which board a device is (e.g. 'ee02-13in3', 'ee04-7in3') — self-reported via
-- X-Device-Board on every request, same pattern as running_firmware_version's
-- X-Firmware-Version (see migrations/0006, lib/auth-device.ts's recordDeviceSeen).
-- NULL until a device's first successful request. Used to resolve the correct
-- per-board firmware_releases row — see migrations/0013.
ALTER TABLE devices ADD COLUMN board TEXT;
