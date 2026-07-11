import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { deleteImageBlobs } from "../../lib/image-store";
import { invalidateRotationCache, invalidateRotationCacheForBucketConsumers } from "../../lib/rotation";

/** Builds the admin join-bucket URL using the incoming request's own origin —
 *  mirrors lib/registration-url.ts's approach for device claim links. */
function bucketJoinUrl(requestUrl: string, token: string): string {
  const origin = new URL(requestUrl).origin;
  const url = new URL(`${origin}/admin`);
  url.searchParams.set("join_bucket", token);
  return url.toString();
}

function generateInviteToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function registerAdminBucketRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/buckets", requireAdmin, async (c) => {
    const body = await c.req.json<{ label?: string }>().catch(() => ({}) as never);
    const label = body.label?.trim();
    if (!label) return c.json({ error: "label is required" }, 400);

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare("INSERT INTO buckets (id, owner_id, label, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, c.var.user.id, label, now)
      .run();

    return c.json({ id, label, owner_id: c.var.user.id, is_owner: true }, 201);
  });

  app.get("/admin/buckets", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT id, owner_id, label, created_at FROM buckets
       WHERE owner_id = ?1 OR id IN (SELECT bucket_id FROM bucket_shares WHERE user_id = ?1)
       ORDER BY created_at ASC`
    )
      .bind(c.var.user.id)
      .all<{ id: string; owner_id: string | null; label: string; created_at: number }>();

    const buckets = rows.results.map((row) => ({ ...row, is_owner: row.owner_id === c.var.user.id }));
    return c.json({ buckets });
  });

  app.patch("/admin/buckets/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const body = await c.req.json<{ label?: string }>().catch(() => ({}) as never);
    const label = body.label?.trim();
    if (!label) return c.json({ error: "label is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare("UPDATE buckets SET label = ? WHERE id = ?").bind(label, id).run();
    return c.json({ id, label });
  });

  app.delete("/admin/buckets/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await invalidateRotationCacheForBucketConsumers(c.env, id);

    const images = await c.env.DB.prepare("SELECT id FROM images WHERE device_key = ?")
      .bind(id)
      .all<{ id: string }>();
    await Promise.all(images.results.map((row) => deleteImageBlobs(c.env, id, row.id)));

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM images WHERE device_key = ?").bind(id),
      c.env.DB.prepare("DELETE FROM device_buckets WHERE bucket_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM bucket_shares WHERE bucket_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM bucket_invites WHERE bucket_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM buckets WHERE id = ?").bind(id),
    ]);

    return c.json({ deleted: id });
  });

  app.post("/admin/buckets/:id/invite", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const token = generateInviteToken();
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO bucket_invites (bucket_id, token, created_at) VALUES (?, ?, ?)
       ON CONFLICT(bucket_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`
    )
      .bind(id, token, now)
      .run();

    return c.json({ url: bucketJoinUrl(c.req.url, token) });
  });

  app.delete("/admin/buckets/:id/invite", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare("DELETE FROM bucket_invites WHERE bucket_id = ?").bind(id).run();
    return c.json({ revoked: id });
  });

  app.post("/admin/buckets/join", requireAdmin, async (c) => {
    const body = await c.req.json<{ token?: string }>().catch(() => ({}) as never);
    if (!body.token) return c.json({ error: "token is required" }, 400);

    const invite = await c.env.DB.prepare(
      `SELECT b.id AS bucket_id, b.label AS label, b.owner_id AS owner_id
       FROM bucket_invites bi JOIN buckets b ON b.id = bi.bucket_id
       WHERE bi.token = ?`
    )
      .bind(body.token)
      .first<{ bucket_id: string; label: string; owner_id: string | null }>();
    if (!invite) return c.json({ error: "Invalid or revoked invite link" }, 404);
    if (invite.owner_id === c.var.user.id) return c.json({ id: invite.bucket_id, label: invite.label });

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      "INSERT INTO bucket_shares (bucket_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(bucket_id, user_id) DO NOTHING"
    )
      .bind(invite.bucket_id, c.var.user.id, now)
      .run();

    return c.json({ id: invite.bucket_id, label: invite.label });
  });

  app.get("/admin/buckets/:id/collaborators", requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id is required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    const rows = await c.env.DB.prepare(
      `SELECT u.id AS id, u.display_name AS display_name FROM bucket_shares bs
       JOIN users u ON u.id = bs.user_id WHERE bs.bucket_id = ?`
    )
      .bind(id)
      .all<{ id: string; display_name: string | null }>();

    return c.json({ collaborators: rows.results });
  });

  app.delete("/admin/buckets/:id/collaborators/:userId", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    if (!id || !userId) return c.json({ error: "id and userId are required" }, 400);

    const bucket = await c.env.DB.prepare("SELECT owner_id FROM buckets WHERE id = ?")
      .bind(id)
      .first<{ owner_id: string | null }>();
    if (!bucket) return c.json({ error: "Not found" }, 404);
    if (bucket.owner_id !== c.var.user.id) return c.json({ error: "Forbidden" }, 403);

    await c.env.DB.prepare("DELETE FROM bucket_shares WHERE bucket_id = ? AND user_id = ?").bind(id, userId).run();
    return c.json({ removed: userId });
  });
}
