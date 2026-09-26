import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";

/** Lifetime session management (migrations/0023_user_sessions.sql): list the
 *  account's sessions, revoke one, revoke everything except the current one,
 *  or log out for real. Before this, "logout" only cleared the browser's
 *  localStorage — the server-side token hash stayed valid forever, and there
 *  was no way to sign out another device without invalidating your own. */
export function registerAdminSessionRoutes(app: Hono<{ Bindings: Env }>) {
  // Lists every non-revoked session for the caller's account, newest first.
  // credential_id is surfaced (not resolved to a friendly name — credentials
  // have no label column) so the UI can group by passkey; is_current lets the
  // client render "this browser" without comparing anything else.
  app.get("/admin/sessions", requireAdmin, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, credential_id, created_at, last_used_at, expires_at
       FROM user_sessions
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`
    )
      .bind(c.var.user.id)
      .all<{ id: string; credential_id: string | null; created_at: number; last_used_at: number | null; expires_at: number | null }>();
    return c.json({
      current_session_id: c.var.user.sessionId,
      sessions: results.map((s) => ({ ...s, is_current: s.id === c.var.user.sessionId })),
    });
  });

  // Real logout: revokes the calling session server-side. The client calls
  // this before clearing its localStorage copy — together they make logout
  // actually mean something (previously the token stayed valid indefinitely).
  // Registered before /admin/sessions/:id so the static path always wins.
  app.delete("/admin/sessions/current", requireAdmin, async (c) => {
    await c.env.DB.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), c.var.user.sessionId)
      .run();
    return c.json({ ok: true });
  });

  // Revokes one session. Scoped to the caller's own sessions — revoking
  // another user's session must 404, not 403, so the endpoint doesn't leak
  // which session ids exist.
  app.delete("/admin/sessions/:id", requireAdmin, async (c) => {
    const result = await c.env.DB.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(Math.floor(Date.now() / 1000), c.req.param("id"), c.var.user.id)
      .run();
    if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // "Sign out other devices": revokes every active session except the one
  // making this call. This is the replacement for the old "Rotate API key"
  // button, minus the collateral damage of logging the current browser out.
  app.post("/admin/sessions/revoke-others", requireAdmin, async (c) => {
    const result = await c.env.DB.prepare(
      "UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?"
    )
      .bind(Math.floor(Date.now() / 1000), c.var.user.id, c.var.user.sessionId)
      .run();
    return c.json({ ok: true, revoked: result.meta.changes ?? 0 });
  });
}
