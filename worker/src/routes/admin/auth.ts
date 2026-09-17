import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { generateApiKey, hashApiKey } from "../../lib/auth-admin";
import { readSharingKeyWrap, type SharingKeyWrap } from "../../lib/webauthn";

export function registerAdminAuthRoutes(app: Hono<{ Bindings: Env }>) {
  // Lets the admin UI verify a pasted API key / minted session is still valid.
  app.get("/admin/me", requireAdmin, async (c) => {
    const row = await c.env.DB.prepare("SELECT display_name FROM users WHERE id = ?")
      .bind(c.var.user.id)
      .first<{ display_name: string | null }>();
    // is_superuser: from the token already resolved by requireAdmin, not a
    // second query — lets the client conditionally show the "Public bucket"
    // checkbox (see root CLAUDE.md's public-buckets plan / migrations/0018).
    return c.json({ id: c.var.user.id, display_name: row?.display_name ?? null, is_superuser: c.var.user.is_superuser });
  });

  app.patch("/admin/me", requireAdmin, async (c) => {
    const body = await c.req.json<{ display_name?: string }>().catch(() => ({}) as never);
    const displayName = body.display_name?.trim();
    if (!displayName || displayName.length > 40) {
      return c.json({ error: "display_name is required and must be 1-40 characters" }, 400);
    }
    await c.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, c.var.user.id).run();
    // Echo is_superuser back too (from the token, unaffected by this update) so
    // admin.ts's `currentUser = await apiFetch(...)` doesn't lose the flag it
    // needs for the public-bucket checkbox after an Edit name round-trip.
    return c.json({ id: c.var.user.id, display_name: displayName, is_superuser: c.var.user.is_superuser });
  });

  // Backfills a credential's PRF-wrapped sharing key outside the passkey
  // ceremony itself — see routes/auth-passkey.ts's /auth/login/verify comment
  // for why this can't just be a second field on that endpoint: its challenge
  // is single-use and already consumed by the time the client's own
  // WebAuthn/crypto code has finished deciding whether a backfill is needed.
  // Authenticated by the ordinary Bearer api_key that same login just minted,
  // not by another passkey ceremony. Guarded by the same IS NULL checks as
  // before — a client that resends this on every login can't clobber an
  // already-established wrap for either column.
  app.patch("/admin/me/sharing-key", requireAdmin, async (c) => {
    const body = await c.req.json<{ credential_id?: string } & Partial<SharingKeyWrap>>().catch(() => ({}) as never);
    if (!body.credential_id) return c.json({ error: "credential_id is required" }, 400);
    const sharingKey = readSharingKeyWrap(body);
    if (!sharingKey) return c.json({ error: "sharing_public_key, wrapped_sharing_key, and wrap_nonce are required" }, 400);

    const cred = await c.env.DB.prepare("SELECT user_id FROM credentials WHERE id = ?")
      .bind(body.credential_id)
      .first<{ user_id: string }>();
    if (!cred || cred.user_id !== c.var.user.id) return c.json({ error: "Not found" }, 404);

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET sharing_public_key = ? WHERE id = ? AND sharing_public_key IS NULL").bind(
        sharingKey.sharing_public_key,
        c.var.user.id
      ),
      c.env.DB
        .prepare(
          "UPDATE credentials SET wrapped_sharing_key = ?, wrap_nonce = ? WHERE id = ? AND wrapped_sharing_key IS NULL"
        )
        .bind(sharingKey.wrapped_sharing_key, sharingKey.wrap_nonce, body.credential_id),
    ]);

    return c.json({ ok: true });
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
