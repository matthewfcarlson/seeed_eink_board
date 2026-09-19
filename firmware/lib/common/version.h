#ifndef FIRMWARE_VERSION_H
#define FIRMWARE_VERSION_H

/**
 * Shared by every board's firmware — one version number, not one per board
 * (see firmware/README.md). Bump this before tagging a release:
 *   1. Bump FIRMWARE_VERSION here to match the tag you're about to push.
 *   2. Commit.
 *   3. `git tag vX.Y.Z && git push mine vX.Y.Z` — this must exactly match
 *      FIRMWARE_VERSION with a leading 'v'.
 *   4. GitHub Actions (.github/workflows/release-firmware.yml) builds every
 *      board's binary and attaches each as its own asset
 *      (firmware-<board>.bin) to the same release.
 *   5. The worker picks them up automatically within 6h, or click "Sync from
 *      GitHub" in /admin — either way it's just cataloged, not rolled out.
 *   6. Set a firmware target for a specific device MAC in /admin to actually
 *      roll it out — there's no shared "every device" tier, see CLAUDE.md's
 *      OTA section.
 */
#define FIRMWARE_VERSION "0.5.2"

#endif // FIRMWARE_VERSION_H
