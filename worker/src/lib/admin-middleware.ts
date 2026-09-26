import type { Context, Next } from "hono";
import type { Env } from "../types";
import { authenticateAdmin, type AuthenticatedUser } from "./auth-admin";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "./rate-limit";

declare module "hono" {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

/** Requires `Authorization: Bearer <session token>`; sets c.var.user or responds 401.
 *  Rate-limited per user id — a leaked token gets bounded throughput,
 *  and a runaway dashboard loop can't hammer D1. Superusers are exempt: they
 *  already have D1 access out-of-band, so a limit here only gets in the way.
 *
 *  The /admin/me session endpoints get their own bucket (RATE_LIMITS.adminMe)
 *  instead of sharing `admin` with the rest of the dashboard: the login flow
 *  calls them right after every passkey ceremony, so heavy dashboard usage
 *  exhausting `admin` must not take the login/session path down with it. */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  // waitUntil lets authenticateAdmin's throttled last_used_at write run
  // post-response instead of adding latency to every admin request.
  const user = await authenticateAdmin(c.env, c.req.raw, c.executionCtx);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const path = c.req.path;
  const isMeEndpoint = path === "/admin/me" || path.startsWith("/admin/me/");
  const bucket = isMeEndpoint ? "adminMe" : "admin";
  const limits = RATE_LIMITS[bucket];
  if (!user.is_superuser && !(await checkRateLimit(c.env, bucket, user.id, limits.limit, limits.windowSeconds))) {
    return rateLimitedResponse(limits.windowSeconds);
  }
  c.set("user", user);
  await next();
}
