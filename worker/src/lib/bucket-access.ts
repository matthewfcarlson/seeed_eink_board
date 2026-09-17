import type { Env } from "../types";

/**
 * Shared by admin/buckets.ts and admin/images.ts. Every bucket requires
 * ownership or an accepted invite (bucket_shares row) — see
 * migrations/0007_buckets.sql and migrations/0009_bucket_ownership.sql (which
 * removed the old globally-shared, ownerless 'default' bucket). Shared
 * collaborators get full read/write, same as the owner, so this one check
 * gates upload/list/delete/raw alike.
 */
export async function assertBucketAccess(env: Env, bucketId: string, userId: string): Promise<boolean> {
  const bucket = await env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
    .bind(bucketId)
    .first<{ owner_id: string | null }>();
  if (!bucket) return false;
  if (bucket.owner_id === userId) return true;
  const shared = await env.DB.prepare("SELECT 1 FROM bucket_shares WHERE bucket_id = ? AND user_id = ?")
    .bind(bucketId, userId)
    .first();
  return !!shared;
}

/**
 * Read-shaped superset of assertBucketAccess: also true for a bucket marked
 * `is_public` (migrations/0018_public_buckets.sql), regardless of ownership
 * or an accepted invite. Deliberately NOT used for any write path (upload,
 * delete image, rename/delete bucket, invite, collaborators, rotate) — a
 * public bucket grants read access only, never write; assertBucketAccess
 * above is untouched and keeps gating all of those exactly as before. Use
 * this only for GET /admin/images, GET /admin/images/:id/raw, and the
 * per-bucket-id check in PATCH /admin/devices/:mac/buckets (assigning a
 * public bucket to your own device is a read of that bucket's key, not a
 * write to the bucket itself).
 */
export async function assertBucketReadAccess(env: Env, bucketId: string, userId: string): Promise<boolean> {
  if (await assertBucketAccess(env, bucketId, userId)) return true;
  const bucket = await env.DB.prepare("SELECT is_public FROM buckets WHERE id = ?")
    .bind(bucketId)
    .first<{ is_public: number }>();
  return !!bucket && bucket.is_public === 1;
}
