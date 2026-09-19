import type { Context, Next } from "hono";
import type { Env } from "../types";
import { authenticateAdmin, type AuthenticatedUser } from "./auth-admin";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "./rate-limit";

declare module "hono" {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

/** Requires `Authorization: Bearer <api_key>`; sets c.var.user or responds 401.
 *  Rate-limited per user id — an API key that leaks gets bounded throughput,
 *  and a runaway dashboard loop can't hammer D1. Superusers are exempt: they
 *  already have D1 access out-of-band, so a limit here only gets in the way. */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const user = await authenticateAdmin(c.env, c.req.raw);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (
    !user.is_superuser &&
    !(await checkRateLimit(c.env, "admin", user.id, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowSeconds))
  ) {
    return rateLimitedResponse(RATE_LIMITS.admin.windowSeconds);
  }
  c.set("user", user);
  await next();
}
