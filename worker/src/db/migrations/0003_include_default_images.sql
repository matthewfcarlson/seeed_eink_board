-- Lets a registered device opt out of the shared 'default' bucket's images
-- being merged into its own rotation. Defaults to on (1) so existing devices
-- immediately start seeing default-bucket images without any admin action.
ALTER TABLE devices ADD COLUMN include_default_images INTEGER NOT NULL DEFAULT 1;
