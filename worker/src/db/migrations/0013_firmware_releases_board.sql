-- firmware_releases becomes board-scoped: two boards' binaries built from the
-- same version tag are two separate rows (different sha256/asset), not one -
-- see firmware/lib/common/version.h's "one shared FIRMWARE_VERSION" design and
-- worker/src/lib/github-release.ts's FIRMWARE_ASSET_NAMES map. SQLite can't
-- ALTER a table's PRIMARY KEY, so this recreates the table (and
-- firmware_targets, which needs a matching composite FK - it was already
-- small, per-device override rows only).
--
-- firmware_targets also gains its own `board` column (not just relying on a
-- JOIN to devices.board) so `FOREIGN KEY (board, version) REFERENCES
-- firmware_releases(board, version)` is expressible at all - SQLite requires
-- the referenced columns to be a table's actual primary/unique key, and
-- firmware_releases.version alone is no longer unique on its own. The PUT
-- /admin/firmware/target/:target handler is the single place this column is
-- ever written, always copied from the target device's own devices.board at
-- that moment, so it can't drift - a device's board never changes after its
-- first report.

CREATE TABLE firmware_releases_new (
  board       TEXT NOT NULL,   -- e.g. 'ee02-13in3', 'ee04-7in3' - matches
                                -- devices.board, the PlatformIO env name, and
                                -- the GitHub release asset suffix (one board-id
                                -- vocabulary used everywhere).
  version     TEXT NOT NULL,   -- e.g. "1.2.0" (tag_name with leading 'v' stripped)
  tag         TEXT NOT NULL,   -- raw GitHub tag_name, e.g. "v1.2.0"
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  source_url  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (board, version)
);

INSERT INTO firmware_releases_new (board, version, tag, sha256, size_bytes, source_url, created_at)
  SELECT 'ee02-13in3', version, tag, sha256, size_bytes, source_url, created_at FROM firmware_releases;

DROP TABLE firmware_releases;
ALTER TABLE firmware_releases_new RENAME TO firmware_releases;

CREATE TABLE firmware_targets_new (
  target      TEXT PRIMARY KEY, -- mac, owned via devices.user_id
  board       TEXT NOT NULL,
  version     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (board, version) REFERENCES firmware_releases(board, version)
);

INSERT INTO firmware_targets_new (target, board, version, updated_at)
  SELECT target, 'ee02-13in3', version, updated_at FROM firmware_targets;

DROP TABLE firmware_targets;
ALTER TABLE firmware_targets_new RENAME TO firmware_targets;
