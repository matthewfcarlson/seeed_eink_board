import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { generateApiKey, hashApiKey } from "../../lib/auth-admin";

export function registerAdminAuthRoutes(app: Hono<{ Bindings: Env }>) {
  // Lets the admin UI verify a pasted API key / minted session is still valid.
  app.get("/admin/me", requireAdmin, async (c) => {
    const row = await c.env.DB.prepare("SELECT display_name FROM users WHERE id = ?")
      .bind(c.var.user.id)
      .first<{ display_name: string | null }>();
    return c.json({ id: c.var.user.id, display_name: row?.display_name ?? null });
  });

  app.patch("/admin/me", requireAdmin, async (c) => {
    const body = await c.req.json<{ display_name?: string }>().catch(() => ({}) as never);
    const displayName = body.display_name?.trim();
    if (!displayName || displayName.length > 40) {
      return c.json({ error: "display_name is required and must be 1-40 characters" }, 400);
    }
    await c.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, c.var.user.id).run();
    return c.json({ id: c.var.user.id, display_name: displayName });
  });

  app.post("/admin/keys/rotate", requireAdmin, async (c) => {
    const newKey = generateApiKey();
    const newHash = await hashApiKey(newKey);
    await c.env.DB.prepare("UPDATE users SET api_key_hash = ? WHERE id = ?")
      .bind(newHash, c.var.user.id)
      .run();

    // Returned exactly once — it is not recoverable after this response, since only
    // the hash is stored.
    return c.json({ api_key: newKey });
  });
}
