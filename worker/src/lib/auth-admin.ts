import type { Env } from "../types";

/** SHA-256 hex digest. Fine for API-key verification (full-entropy random key, not a
 *  password) — no bcrypt/scrypt needed since brute-forcing 256 bits of entropy isn't
 *  the threat model here. */
export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `eink_<43 base64url chars>` — 32 random bytes, full entropy. */
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
}

/** Verifies `Authorization: Bearer <key>` against users.api_key_hash. Returns null if absent/invalid. */
export async function authenticateAdmin(env: Env, request: Request): Promise<AuthenticatedUser | null> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const key = header.slice("Bearer ".length).trim();
  if (!key) return null;

  const keyHash = await hashApiKey(key);
  const row = await env.DB.prepare("SELECT id, is_superuser FROM users WHERE api_key_hash = ?")
    .bind(keyHash)
    .first<{ id: string; is_superuser: number }>();

  return row ? { id: row.id, is_superuser: row.is_superuser === 1 } : null;
}
