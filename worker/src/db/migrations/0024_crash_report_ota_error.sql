-- OTA download/verify/flash failures that never got as far as rebooting into
-- the new image (firmware's performFirmwareOTA) are now reported through
-- POST /crash_report too, alongside crashes and rollbacks. For these rows
-- firmware_version is the still-running version, ota_target_version the one
-- that failed, and ota_error a short token (e.g. "http_404",
-- "sha256_mismatch"). Both null for every other report kind.
ALTER TABLE crash_reports ADD COLUMN ota_target_version TEXT;
ALTER TABLE crash_reports ADD COLUMN ota_error TEXT;
