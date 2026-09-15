import type { Env } from "../types";

// Every release built by .github/workflows/release-firmware.yml attaches each
// board's compiled binary under a board-specific asset name (not a generic
// "firmware.bin"), so multiple boards' binaries can coexist as distinct
// assets on the same release. Keys match devices.board /
// firmware_releases.board / each board's PlatformIO environment name — one
// board-id vocabulary used everywhere. Add a board here once its firmware
// gains OTA support (see firmware/README.md).
export const FIRMWARE_ASSET_NAMES: Record<string, string> = {
  "ee02-13in3": "firmware-ee02-13in3.bin",
  "ee04-7in3": "firmware-ee04-7in3.bin",
};

export const KNOWN_BOARDS = Object.keys(FIRMWARE_ASSET_NAMES);

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

export interface LatestFirmwareRelease {
  version: string; // tag_name with a leading 'v' stripped
  tag: string;
  downloadUrl: string;
  size: number;
}

function githubHeaders(env: Env): HeadersInit {
  // GitHub's API rejects requests with no User-Agent.
  const headers: Record<string, string> = {
    "User-Agent": "eink-worker",
    Accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

/** One GET to GitHub's releases/latest — call once per sync and reuse across
 *  every board via resolveBoardAsset, rather than re-fetching per board. */
export async function fetchLatestGitHubRelease(env: Env): Promise<GitHubRelease> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, {
    headers: githubHeaders(env),
  });
  if (!res.ok) {
    throw new Error(`GitHub releases/latest failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GitHubRelease;
}

/**
 * Resolves one board's asset out of an already-fetched GitHub release. Not
 * every release necessarily includes every known board's asset (e.g. a board
 * added to FIRMWARE_ASSET_NAMES before its release workflow step exists yet)
 * — that's a per-board "not in this release" condition for the caller to
 * handle, not a hard failure here.
 */
export function resolveBoardAsset(release: GitHubRelease, board: string): LatestFirmwareRelease | null {
  const assetName = FIRMWARE_ASSET_NAMES[board];
  if (!assetName) throw new Error(`Unknown board id: ${board}`);

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) return null;

  return {
    version: release.tag_name.replace(/^v/, ""),
    tag: release.tag_name,
    downloadUrl: asset.browser_download_url,
    size: asset.size,
  };
}

/** Downloads a release asset's raw bytes (redirects to GitHub's CDN are followed automatically). */
export async function downloadFirmwareAsset(env: Env, downloadUrl: string): Promise<Uint8Array> {
  const res = await fetch(downloadUrl, {
    headers: { "User-Agent": "eink-worker", Accept: "application/octet-stream" },
  });
  if (!res.ok) {
    throw new Error(`Failed to download firmware asset: ${res.status} ${await res.text()}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
