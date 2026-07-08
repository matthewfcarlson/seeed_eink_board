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
