import type { Env } from "../types";

// Every release built by .github/workflows/release-firmware.yml attaches the
// compiled binary under this fixed asset name, regardless of version.
const FIRMWARE_ASSET_NAME = "firmware.bin";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
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

/** Looks up the latest GitHub release for env.GITHUB_REPO and its firmware.bin asset. */
export async function fetchLatestFirmwareRelease(env: Env): Promise<LatestFirmwareRelease> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, {
    headers: githubHeaders(env),
  });
  if (!res.ok) {
    throw new Error(`GitHub releases/latest failed: ${res.status} ${await res.text()}`);
  }
  const release = (await res.json()) as GitHubRelease;

  const asset = release.assets.find((a) => a.name === FIRMWARE_ASSET_NAME);
  if (!asset) {
    throw new Error(`Latest release ${release.tag_name} has no ${FIRMWARE_ASSET_NAME} asset`);
  }

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
