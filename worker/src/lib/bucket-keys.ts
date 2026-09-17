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

/**
 * Upserts one principal's wrapped copy of a bucket key at a specific key
 * version — called whenever a bucket is created (wrap for the owner, version
 * 1), a share is accepted (wrap for the new collaborator, at the bucket's
 * current version), a bucket is assigned to a device (same), or a rotation
 * is started/finalized (wrap at `key_version + 1` — see
 * migrations/0016_bucket_key_rotation.sql and routes/admin/buckets.ts's
 * rotate/* handlers). Idempotent: re-wrapping the same
 * (bucket, principal, key_version) tuple just replaces the row — an old and
 * a new version can coexist for the same principal mid-rotation, which is
 * exactly why key_version joined the primary key.
 */
export async function upsertBucketKey(
  env: Env,
  bucketId: string,
  principalType: PrincipalType,
  principalId: string,
  wrapped: WrappedBucketKey,
  keyVersion: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO bucket_keys (bucket_id, principal_type, principal_id, key_version, ephemeral_pub, nonce, ciphertext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_id, principal_type, principal_id, key_version) DO UPDATE SET
       ephemeral_pub = excluded.ephemeral_pub,
       nonce = excluded.nonce,
       ciphertext = excluded.ciphertext,
       created_at = excluded.created_at`
  )
    .bind(bucketId, principalType, principalId, keyVersion, wrapped.ephemeralPub, wrapped.nonce, wrapped.ciphertext, now)
    .run();
}

/** One principal's wrapped key at one specific version — callers that just
 *  want "the current usable key" must pass buckets.key_version themselves
 *  (they typically already have the bucket row in hand). */
export async function getBucketKey(
  env: Env,
  bucketId: string,
  principalType: PrincipalType,
  principalId: string,
  keyVersion: number
): Promise<WrappedBucketKey | null> {
  const row = await env.DB.prepare(
    "SELECT ephemeral_pub, nonce, ciphertext FROM bucket_keys WHERE bucket_id = ? AND principal_type = ? AND principal_id = ? AND key_version = ?"
  )
    .bind(bucketId, principalType, principalId, keyVersion)
    .first<{ ephemeral_pub: string; nonce: string; ciphertext: string }>();
  return row ? { ephemeralPub: row.ephemeral_pub, nonce: row.nonce, ciphertext: row.ciphertext } : null;
}

/** Every bucket key wrapped for a given device, at every version it currently
 *  holds — fed into /device_config alongside the schedule/firmware target it
 *  already resolves each wake. Deliberately NOT filtered to the bucket's
 *  current key_version: mid-rotation a device may still only hold the OLD
 *  version's key while some images are still encrypted under it, so
 *  device_app.h needs both and picks the right one per image via
 *  /image_packed's X-Bucket-Key-Version header. */
export async function getBucketKeysForDevice(
  env: Env,
  deviceMac: string
): Promise<Array<{ bucketId: string; keyVersion: number } & WrappedBucketKey>> {
  const rows = await env.DB.prepare(
    "SELECT bucket_id, key_version, ephemeral_pub, nonce, ciphertext FROM bucket_keys WHERE principal_type = 'device' AND principal_id = ?"
  )
    .bind(deviceMac)
    .all<{ bucket_id: string; key_version: number; ephemeral_pub: string; nonce: string; ciphertext: string }>();
  return rows.results.map((row) => ({
    bucketId: row.bucket_id,
    keyVersion: row.key_version,
    ephemeralPub: row.ephemeral_pub,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
  }));
}

/**
 * Deletes every version of a (bucket, principal)'s wrapped key. Used by the
 * ordinary collaborator/device-removal paths — cosmetic there, not a real
 * revocation (see root CLAUDE.md's Known gaps: a principal who already
 * unwrapped a key keeps it until the bucket is actually rotated), just
 * cleanup so a re-invited principal gets a fresh wrap instead of a stale row.
 */
export async function deleteBucketKey(env: Env, bucketId: string, principalType: PrincipalType, principalId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM bucket_keys WHERE bucket_id = ? AND principal_type = ? AND principal_id = ?")
    .bind(bucketId, principalType, principalId)
    .run();
}

export async function deleteBucketKeysForBucket(env: Env, bucketId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM bucket_keys WHERE bucket_id = ?").bind(bucketId).run();
}

/** One principal this Worker recognizes for bucket-key wrapping purposes —
 *  either the account itself (user) or a physical board (device). */
export interface PrincipalRef {
  type: PrincipalType;
  id: string;
}

/**
 * Pure logic, no D1: given a bucket's owner plus the *live* rows of its
 * bucket_shares/device_buckets tables, computes the full set of principals
 * currently authorized to hold that bucket's key. Factored out specifically
 * so POST /admin/buckets/:id/rotate/:rotationId/finalize can recompute this
 * at finalize time (not reuse whatever was authorized when the rotation
 * started) — a share or device assignment added mid-rotation must still get
 * a new-version wrap, and one removed mid-rotation must not. De-duplicates
 * the owner against bucket_shares in case a stale self-share row exists.
 */
export function computeAuthorizedPrincipals(
  ownerId: string | null,
  shareUserIds: string[],
  deviceMacs: string[]
): PrincipalRef[] {
  const principals: PrincipalRef[] = [];
  const seenUsers = new Set<string>();
  if (ownerId) {
    principals.push({ type: "user", id: ownerId });
    seenUsers.add(ownerId);
  }
  for (const userId of shareUserIds) {
    if (seenUsers.has(userId)) continue;
    seenUsers.add(userId);
    principals.push({ type: "user", id: userId });
  }
  for (const mac of deviceMacs) {
    principals.push({ type: "device", id: mac });
  }
  return principals;
}
