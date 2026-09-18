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

// The sizes below are protocol-fixed, not arbitrary limits: wrapKeyFor()
// (client/crypto.ts) always wraps a 32-byte AES-256 bucket key, so every
// field's length is known exactly — a 65-byte ephemeral P-256 point is 88
// base64 chars, a 12-byte GCM nonce is 16, and 32 plaintext bytes + 16-byte
// GCM tag = 48 bytes = 64 chars. Accepting anything else stored junk that
// no unwrap could ever succeed on.
const WRAPPED_KEY_B64_LENGTHS = { ephemeralPub: 88, nonce: 16, ciphertext: 64 } as const;

function isWrappedBucketKey(value: unknown): value is WrappedBucketKey {
  const v = value as Partial<WrappedBucketKey> | null | undefined;
  if (!v) return false;
  return (
    (typeof v.ephemeralPub === "string" && v.ephemeralPub.length === WRAPPED_KEY_B64_LENGTHS.ephemeralPub) &&
    (typeof v.nonce === "string" && v.nonce.length === WRAPPED_KEY_B64_LENGTHS.nonce) &&
    (typeof v.ciphertext === "string" && v.ciphertext.length === WRAPPED_KEY_B64_LENGTHS.ciphertext)
  );
}

/** Validates a client-supplied wrapped-key payload: exact base64 lengths for
 *  each field (see WRAPPED_KEY_B64_LENGTHS — these are fixed by the wrap
 *  format, not a policy choice) but not its crypto content — the Worker has
 *  no way to check that without the private key. */
export function parseWrappedBucketKey(value: unknown): WrappedBucketKey | null {
  return isWrappedBucketKey(value) ? value : null;
}

/**
 * Builds (but doesn't run) the upsert statement for one principal's wrapped
 * copy of a bucket key at a specific key version — split out from
 * upsertBucketKey so a caller that must not let this succeed independently
 * of a sibling write (see POST /admin/buckets below: a bucket row committed
 * without its owner's key row is a permanently unwritable, unrecoverable
 * bucket, since the Worker never sees the raw key to re-wrap later) can fold
 * it into one `env.DB.batch([...])` instead of two separate `.run()` calls.
 */
export function bucketKeyUpsertStatement(
  env: Env,
  bucketId: string,
  principalType: PrincipalType,
  principalId: string,
  wrapped: WrappedBucketKey,
  keyVersion: number
): D1PreparedStatement {
  const now = Math.floor(Date.now() / 1000);
  return env.DB.prepare(
    `INSERT INTO bucket_keys (bucket_id, principal_type, principal_id, key_version, ephemeral_pub, nonce, ciphertext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_id, principal_type, principal_id, key_version) DO UPDATE SET
       ephemeral_pub = excluded.ephemeral_pub,
       nonce = excluded.nonce,
       ciphertext = excluded.ciphertext,
       created_at = excluded.created_at`
  ).bind(bucketId, principalType, principalId, keyVersion, wrapped.ephemeralPub, wrapped.nonce, wrapped.ciphertext, now);
}

/**
 * Upserts one principal's wrapped copy of a bucket key at a specific key
 * version — called whenever a share is accepted (wrap for the new
 * collaborator, at the bucket's current version), a bucket is assigned to a
 * device (same), or a rotation is started/finalized (wrap at
 * `key_version + 1` — see migrations/0016_bucket_key_rotation.sql and
 * routes/admin/buckets.ts's rotate/* handlers). Idempotent: re-wrapping the
 * same (bucket, principal, key_version) tuple just replaces the row — an old
 * and a new version can coexist for the same principal mid-rotation, which is
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
  await bucketKeyUpsertStatement(env, bucketId, principalType, principalId, wrapped, keyVersion).run();
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
