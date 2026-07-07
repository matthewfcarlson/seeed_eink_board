import { DEFAULT_DEVICE_KEY, type Env } from "../types";

/**
 * Shared by admin/buckets.ts and admin/images.ts. The shared 'default' bucket
 * (owner_id NULL) is writable by any authenticated user — matches
 * image_server.py's single shared images/default/ folder, no per-user isolation.
 * Everything else requires ownership or an accepted invite (bucket_shares row) —
 * see migrations/0007_buckets.sql. Shared collaborators get full read/write,
 * same as the owner, so this one check gates upload/list/delete/raw alike.
 */
export async function assertBucketAccess(env: Env, bucketId: string, userId: string): Promise<boolean> {
  if (bucketId === DEFAULT_DEVICE_KEY) return true;
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
