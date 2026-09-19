import type { Env } from "../types";

/**
 * Fixed-window rate limiting backed by D1 — one atomic upsert per check, one
 * row per (name, identity, windowStart). Chosen over a Workers rate-limiting
 * binding (requires a specific plan tier and a wrangler resource to wire up)
 * and over KV (eventually consistent — a KV counter can lag tens of seconds,
 * which defeats the whole point). D1 writes are serialized, so the upsert
 * here is a correct counter even under concurrent requests.
 *
 * Limits are deliberately generous — this is abuse/accident protection
 * (runaway loops, scripted hammering, a wedged device), not a security
 * boundary. All limits are per-identity: per-IP for unauthenticated endpoints,
 * per-MAC for device-facing ones, per-user for /admin. A failing limiter
 * fails OPEN (logged, not thrown) so a D1 hiccup can never take the API down.
 */

export const RATE_LIMITS = {
  /** Passkey ceremonies: mint-challenge + verify pairs. A browser does a
   *  handful per session; an attacker scripting the unauthenticated endpoints
   *  burns KV challenge writes and WebAuthn verify CPU. Per IP, 5-min window. */
  auth: { limit: 30, windowSeconds: 300 },
  /** Crash reports: a genuine crash loop reboots-and-reports every few
   *  seconds — 30/hour catches a hot loop without dropping a device that had
   *  a bad day. Per MAC, 1-hour window. */
  crashReport: { limit: 30, windowSeconds: 3600 },
  /** Device-facing endpoints: a device at the minimum refresh interval (1
   *  min) makes up to ~3 requests per wake (/device_config, /hash,
   *  /image_packed) plus the occasional OTA download — 300/hour leaves an
   *  order of magnitude of headroom over honest behavior. Per MAC. */
  device: { limit: 300, windowSeconds: 3600 },
  /** Admin API: driven by the dashboard, which does a few parallel calls per
   *  render — 300 per 5 min per user is far above human usage but bounds
   *  scripted abuse of a leaked key. */
  admin: { limit: 300, windowSeconds: 300 },
  /** /admin/me session endpoints (whoami, display name, sharing-key
   *  backfill) — deliberately NOT in the `admin` bucket. The login flow calls
   *  these right after a passkey ceremony and on every page load, so a burst
   *  of heavy dashboard calls must never be able to lock an account out of
   *  checking its own session or logging in. */
  adminMe: { limit: 60, windowSeconds: 300 },
} as const;

/** True when the request is within `limit` for this window; false once the
 *  counter exceeds it. Fails open on any D1 error. */
export async function checkRateLimit(
  env: Env,
  name: string,
  identity: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSeconds);
    // The window start in the key makes each window a fresh row — no
    // reset logic needed, and the current window's row is the only one the
    // upsert can ever conflict on.
    const key = `${name}:${identity}:${windowStart}`;
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, count) VALUES (?, 1)
       ON CONFLICT(key) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(key)
      .first<{ count: number }>();
    const count = row?.count;
    if (count === undefined || count === null) {
      // RETURNING gave nothing (shouldn't happen for a working upsert) —
      // fail open rather than lock the endpoint.
      return true;
    }
    // Opportunistic cleanup: drop this limiter's rows from earlier windows.
    // ~2% of requests pay one extra DELETE; stale rows otherwise sit until
    // the next hit. Key prefix is a code constant, so LIKE is safe.
    if (Math.random() < 0.02) {
      await env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE ? AND key <> ?")
        .bind(`${name}:${identity}:%`, key)
        .run();
    }
    return count <= limit;
  } catch (err) {
    console.error("Rate limit check failed (failing open):", err);
    return true;
  }
}

/** Hono helper: 429 with a Retry-After pointing at the next window boundary. */
export function rateLimitedResponse(windowSeconds: number): Response {
  const now = Math.floor(Date.now() / 1000);
  const retryAfter = windowSeconds - (now % windowSeconds);
  return new Response("Rate limit exceeded", {
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  });
}
