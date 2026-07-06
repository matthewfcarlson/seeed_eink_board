export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  // "owner/repo" that firmware releases are published from — see lib/github-release.ts.
  GITHUB_REPO: string;
  // Optional: raises the unauthenticated GitHub API rate limit (60/hr) and would be
  // required if GITHUB_REPO were ever made private. Set via `wrangler secret put`.
  GITHUB_TOKEN?: string;
}

export interface ImageMeta {
  id: string;
  filename: string;
  packedHash: string;
  packedBytes: number;
  // The device_key bucket this image's KV blobs actually live under (its own
  // key, or 'default' when merged in from the shared bucket) — see rotation.ts.
  sourceDeviceKey: string;
}

export interface RotationSnapshot {
  currentIndex: number;
  lastReturned: string | null; // image id
  images: ImageMeta[]; // ORDER BY filename ASC, computed at cache-population time
}

export interface ScheduleConfig {
  refresh_interval_minutes?: number;
  active_start_hour?: number;
  active_end_hour?: number;
  timezone_offset_minutes?: number;
}

export interface DeviceLookup {
  deviceKey: string; // mac if registered, else 'default'
  userId: string | null;
}

export interface FirmwareRelease {
  version: string; // e.g. "1.2.0"
  tag: string; // e.g. "v1.2.0"
  sha256: string;
  size_bytes: number;
  source_url: string;
  created_at: number;
}

export const DEFAULT_DEVICE_KEY = "default";
export const GLOBAL_SCHEDULE_TARGET = "global";
export const PACKED_BYTES = 960000;

// Buffer is 1600x1200 landscape to match firmware; source images are fit to
// 1200x1600 portrait first, then rotated 270° — see image_server.py's process_image_to_packed.
export const BUFFER_WIDTH = 1600;
export const BUFFER_HEIGHT = 1200;
export const PORTRAIT_WIDTH = 1200;
export const PORTRAIT_HEIGHT = 1600;

export type DitherAlgorithm = "floyd_steinberg" | "atkinson" | "ordered";
export const DITHER_ALGORITHMS: DitherAlgorithm[] = ["floyd_steinberg", "atkinson", "ordered"];
