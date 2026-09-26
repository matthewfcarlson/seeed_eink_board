import type { Env } from "../types";

/** SHA-256 hex digest. Fine for bearer-token verification (full-entropy random
 *  token, not a password) — no bcrypt/scrypt needed since brute-forcing 256 bits
 *  of entropy isn't the threat model here. */
export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `eink_<43 base64url chars>` — 32 random bytes, full entropy. Doubles as the
 *  minting format for per-login session tokens (migrations/0023_user_sessions.sql);
 *  the Bearer-string format is unchanged so the middleware stays untouched. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64url = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `eink_${b64url}`;
}

export interface AuthenticatedUser {
  id: string;
  // Manually flipped in D1 only — see migrations/0018_public_buckets.sql.
  // Fetched here (not a separate query per route) since every superuser-gated
  // route already needs c.var.user populated anyway.
  is_superuser: boolean;
  // The user_sessions row this Bearer token resolved to — revocation routes
  // (routes/admin/sessions.ts) use it to target "this session" without the
  // client ever needing to know the row id.
  sessionId: string;
}

/** Verifies `Authorization: Bearer <token>` against user_sessions.token_hash
 *  (one row per passkey ceremony — see migrations/0023_user_sessions.sql).
 *  Returns null if absent/invalid/revoked/expired.
 *
 *  `last_used_at` is updated in the same request only when stale by more than
 *  an hour, so dashboard polling stays read-only against D1 instead of turning
 *  every request into a write. When the caller supplies an ExecutionContext
 *  the write is fire-and-forget (waitUntil); a dropped update costs one stale
 *  timestamp, never an auth failure. */
export async function authenticateAdmin(
  env: Env,
  request: Request,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<AuthenticatedUser | null> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const key = header.slice("Bearer ".length).trim();
  if (!key) return null;

  const keyHash = await hashApiKey(key);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB
    .prepare(
      `SELECT s.id AS session_id, s.last_used_at, u.id AS user_id, u.is_superuser
       FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)`
    )
    .bind(keyHash, now)
    .first<{ session_id: string; last_used_at: number | null; user_id: string; is_superuser: number }>();

  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > SESSION_LAST_USED_THROTTLE_SECONDS) {
    const update = env.DB.prepare("UPDATE user_sessions SET last_used_at = ? WHERE id = ?")
      .bind(now, row.session_id)
      .run();
    if (ctx) ctx.waitUntil(update);
    else await update;
  }

  return { id: row.user_id, is_superuser: row.is_superuser === 1, sessionId: row.session_id };
}

/** Minimum interval between last_used_at writes for one session. */
const SESSION_LAST_USED_THROTTLE_SECONDS = 3600;
