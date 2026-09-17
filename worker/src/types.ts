import type { PackedEncoding } from "./lib/media-constants";

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
  // 'identity' or 'deflate-raw' - see lib/media-constants.ts's PackedEncoding
  // and migrations/0017_packed_encoding.sql. Tells /image_packed (via the
  // X-Packed-Encoding response header) and firmware which decode path to use.
  packedEncoding: PackedEncoding;
  // Which of the device's subscribed buckets this image's KV blobs actually live
  // under (a device can subscribe to several — see device_buckets in schema.sql) —
  // see rotation.ts.
  sourceDeviceKey: string;
  // Which key version this image's KV blobs are actually encrypted under right
  // now (see migrations/0016_bucket_key_rotation.sql) — carried through to
  // /image_packed's X-Bucket-Key-Version header so a device mid-rotation (still
  // holding both an old and new bucket key) knows which one decrypts this
  // particular image.
  keyVersion: number;
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
  deviceKey: string; // mac if registered (i.e. has a secret), else 'default'
  userId: string | null;
  secret: string | null; // hex HMAC key; present iff deviceKey !== 'default'
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

// Geometry/dither-algorithm constants live in lib/media-constants.ts (so
// client/ code can import them without pulling in the Env interface above,
// which references ambient Workers-only types) — re-exported here since
// every existing Worker-side import expects them from "../types".
export * from "./lib/media-constants";
