-- "Human random" image selection (see lib/rotation.ts). Rotation used to be a
-- plain sequential cursor: every subscribed bucket's images merged, sorted by
-- filename, and current_index pointing at the next one. It's now a seeded
-- random pick that (a) never comes from the same bucket twice in a row while
-- another subscribed bucket has an image to offer, and (b) skips images still
-- inside a recency window.
--
-- That needs two things to be durable. last_bucket_id, because the bucket of
-- the last-served image can't be recovered from images/last_returned once that
-- image (or the whole bucket subscription) is gone. recent_image_ids, because
-- without the history a cold cache would happily repeat what was just shown.
--
-- current_index goes away with the cursor it tracked: the pick is derived from
-- last_returned + recent_image_ids + the image set, not from a position.
ALTER TABLE rotation_state ADD COLUMN last_bucket_id TEXT;
ALTER TABLE rotation_state ADD COLUMN recent_image_ids TEXT; -- JSON array of image ids, newest first
ALTER TABLE rotation_state DROP COLUMN current_index;
