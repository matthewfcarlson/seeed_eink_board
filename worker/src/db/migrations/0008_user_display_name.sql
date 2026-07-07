-- Human-settable name shown instead of "Account <id prefix>" — also how a user
-- identifies themselves in a shared bucket's collaborator list.
ALTER TABLE users ADD COLUMN display_name TEXT;
