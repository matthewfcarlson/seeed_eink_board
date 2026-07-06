import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { generateApiKey, hashApiKey } from "../../lib/auth-admin";

export function registerAdminAuthRoutes(app: Hono<{ Bindings: Env }>) {
  // Lets the admin UI verify a pasted API key / minted session is still valid.
  app.get("/admin/me", requireAdmin, async (c) => {
    return c.json({ id: c.var.user.id });
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
