import type { Context, Next } from "hono";
import type { Env } from "../types";
import { authenticateAdmin, type AuthenticatedUser } from "./auth-admin";

declare module "hono" {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

/** Requires `Authorization: Bearer <api_key>`; sets c.var.user or responds 401. */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const user = await authenticateAdmin(c.env, c.req.raw);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
}
