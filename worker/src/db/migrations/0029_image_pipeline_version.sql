-- Which version of the client-side image pipeline (lib/media-constants.ts's
-- IMAGE_PIPELINE_VERSION) produced an image's current variants. The
-- dashboard flags any image below the current version with a small badge,
-- so a pipeline change (crop storage, tone curve, palette, dither) shows
-- which photos still carry the old rendering.
--
-- Every image that exists before this migration was made by version 1 (no
-- cropped source - see 0028_image_cropped_source.sql). Trusted client
-- metadata like dither_algorithm; the Worker can't verify it.
ALTER TABLE images ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 1;
