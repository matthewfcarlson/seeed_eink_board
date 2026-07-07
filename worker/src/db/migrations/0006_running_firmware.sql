-- The version a device last reported running (via X-Firmware-Version on every
-- request, see main.cpp's addCommonHeaders()) — distinct from firmware_targets,
-- which is what an admin *wants* it running. Lets the admin UI show actual vs.
-- desired version side by side.
ALTER TABLE devices ADD COLUMN running_firmware_version TEXT;
