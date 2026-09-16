import type { Env } from "../types";

/** ECIES-wrapped copy of a bucket's AES-256-GCM key for one principal (a user
 *  or a device) — see migrations/0015_bucket_encryption.sql and root
 *  CLAUDE.md's encrypted-buckets plan. All fields are base64, produced by
 *  client/crypto.ts's wrapKeyFor(); the Worker only ever stores and returns
 *  this ciphertext, never the raw key. */
export interface WrappedBucketKey {
  ephemeralPub: string;
  nonce: string;
  ciphertext: string;
}

export type PrincipalType = "user" | "device";

function isWrappedBucketKey(value: unknown): value is WrappedBucketKey {
  const v = value as Partial<WrappedBucketKey> | null | undefined;
  return !!v && typeof v.ephemeralPub === "string" && typeof v.nonce === "string" && typeof v.ciphertext === "string";
}

/** Validates a client-supplied wrapped-key payload shape (not its crypto
 *  content — the Worker has no way to check that without the private key). */
export function parseWrappedBucketKey(value: unknown): WrappedBucketKey | null {
  return isWrappedBucketKey(value) ? value : null;
}

/** Upserts one principal's wrapped copy of a bucket key — called whenever a
 *  bucket is created (wrap for the owner), a share is accepted (wrap for the
 *  new collaborator), or a bucket is assigned to a device (wrap for the
 *  device). Idempotent: re-wrapping the same (bucket, principal) pair (e.g.
 *  re-saving a device's bucket list) just replaces the row. */
export async function upsertBucketKey(
  env: Env,
  bucketId: string,
  principalType: PrincipalType,
  principalId: string,
  wrapped: WrappedBucketKey
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO bucket_keys (bucket_id, principal_type, principal_id, ephemeral_pub, nonce, ciphertext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_id, principal_type, principal_id) DO UPDATE SET
       ephemeral_pub = excluded.ephemeral_pub,
       nonce = excluded.nonce,
       ciphertext = excluded.ciphertext,
       created_at = excluded.created_at`
  )
    .bind(bucketId, principalType, principalId, wrapped.ephemeralPub, wrapped.nonce, wrapped.ciphertext, now)
    .run();
}

export async function getBucketKey(
  env: Env,
  bucketId: string,
  principalType: PrincipalType,
  principalId: string
): Promise<WrappedBucketKey | null> {
  const row = await env.DB.prepare(
    "SELECT ephemeral_pub, nonce, ciphertext FROM bucket_keys WHERE bucket_id = ? AND principal_type = ? AND principal_id = ?"
  )
    .bind(bucketId, principalType, principalId)
    .first<{ ephemeral_pub: string; nonce: string; ciphertext: string }>();
  return row ? { ephemeralPub: row.ephemeral_pub, nonce: row.nonce, ciphertext: row.ciphertext } : null;
}

/** Every bucket key wrapped for a given device — fed into /device_config
 *  alongside the schedule/firmware target it already resolves each wake. */
export async function getBucketKeysForDevice(
  env: Env,
  deviceMac: string
): Promise<Array<{ bucketId: string } & WrappedBucketKey>> {
  const rows = await env.DB.prepare(
    "SELECT bucket_id, ephemeral_pub, nonce, ciphertext FROM bucket_keys WHERE principal_type = 'device' AND principal_id = ?"
  )
    .bind(deviceMac)
    .all<{ bucket_id: string; ephemeral_pub: string; nonce: string; ciphertext: string }>();
  return rows.results.map((row) => ({
    bucketId: row.bucket_id,
    ephemeralPub: row.ephemeral_pub,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
  }));
}

export async function deleteBucketKey(
  env: Env,
  bucketId: string,
  principalType: PrincipalType,
  principalId: string
): Promise<void> {
  await env.DB.prepare("DELETE FROM bucket_keys WHERE bucket_id = ? AND principal_type = ? AND principal_id = ?")
    .bind(bucketId, principalType, principalId)
    .run();
}

export async function deleteBucketKeysForBucket(env: Env, bucketId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM bucket_keys WHERE bucket_id = ?").bind(bucketId).run();
}
