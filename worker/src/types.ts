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

/**
 * Which image, in which bucket, at which key version — purely identity, not
 * bytes. A device's actual packed bytes/hash/encoding for this image are a
 * per-(image, board) variant (migrations/0019_image_board_variants.sql,
 * lib/image-store.ts's getImageVariant) resolved at serve time from the
 * requesting device's own X-Device-Board, not cached here — a bucket can mix
 * EE02/EE04 devices, so there's no single "this image's bytes" to cache
 * per rotation snapshot.
 */
export interface ImageMeta {
  id: string;
  filename: string;
  // Which of the device's subscribed buckets this image lives under (a
  // device can subscribe to several — see device_buckets in schema.sql) —
  // see rotation.ts.
  sourceDeviceKey: string;
  // Which key version this image's raw blob and every board variant's blobs
  // are actually encrypted under right now (see migrations/
  // 0016_bucket_key_rotation.sql) — carried through to /image_packed's
  // X-Bucket-Key-Version header so a device mid-rotation (still holding both
  // an old and new bucket key) knows which one decrypts this particular
  // image.
  keyVersion: number;
}

export interface RotationSnapshot {
  lastReturned: string | null; // image id
  // Which bucket lastReturned came from, kept as its own field rather than
  // looked up through `images` because the next pick needs it even after that
  // image (or the whole bucket) is gone — see rotation.ts's peekPendingImage.
  lastBucketId: string | null;
  // Recently served image ids, newest first, capped at RECENT_HISTORY_CAP. The
  // pick avoids the newest slice of this (see rotation.ts's recentWindow) so a
  // random rotation doesn't repeat a photo the viewer just saw.
  recentImageIds: string[];
  // ORDER BY filename ASC, computed at cache-population time. Not a rotation
  // order any more (selection is random) — just a stable order, so the seeded
  // pick is identical for /hash and the /image_packed that follows it.
  images: ImageMeta[];
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
