#ifndef FIRMWARE_VERSION_H
#define FIRMWARE_VERSION_H

/**
 * Bump this before tagging a release. The release process (see
 * .github/workflows/release-firmware.yml and firmware/README.md) is:
 *   1. Bump FIRMWARE_VERSION here to match the tag you're about to push.
 *   2. Commit.
 *   3. `git tag vX.Y.Z && git push mine vX.Y.Z` — this must exactly match
 *      FIRMWARE_VERSION with a leading 'v'.
 *   4. GitHub Actions builds firmware.bin and attaches it to the release.
 *   5. The worker picks it up automatically within 6h, or click "Sync from
 *      GitHub" in /admin — either way it's just cataloged, not rolled out.
 *   6. Set a firmware target (device MAC first, ideally, then 'default'/'global')
 *      in /admin to actually roll it out — see CLAUDE.md's OTA section.
 */
#define FIRMWARE_VERSION "0.3.0"

#endif // FIRMWARE_VERSION_H
