import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET, type Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { fetchLatestFirmwareRelease, downloadFirmwareAsset } from "../../lib/github-release";
import { computeSha256Hex, putFirmwareBinary } from "../../lib/firmware-store";
import { invalidateFirmwareTargetCache } from "../../lib/firmware-target";

/** Same ownership model as admin/schedule.ts's assertTargetOwnership: 'default'/'global'
 *  are shared across all users, a mac target must belong to the caller. */
async function assertTargetOwnership(env: Env, target: string, userId: string): Promise<boolean> {
  if (target === DEFAULT_DEVICE_KEY || target === GLOBAL_SCHEDULE_TARGET) return true;
  const row = await env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
    .bind(target)
    .first<{ user_id: string | null }>();
  return row?.user_id === userId;
}

/**
 * Pulls the latest GitHub release into the worker's own catalog (D1 metadata +
 * KV blob). This never rolls anything out to devices by itself — see
 * lib/firmware-target.ts — it only makes a version available to be targeted.
 * Shared between the manual /admin/firmware/sync route and index.ts's scheduled()
 * cron handler, so "let Cloudflare pick up new releases" works without a click,
 * while actual device rollout still requires an explicit admin action.
 */
export async function syncLatestFirmwareRelease(env: Env): Promise<{ version: string; isNew: boolean }> {
  const latest = await fetchLatestFirmwareRelease(env);

  const existing = await env.DB.prepare("SELECT version FROM firmware_releases WHERE version = ?")
    .bind(latest.version)
    .first();
  if (existing) return { version: latest.version, isNew: false };

  const bytes = await downloadFirmwareAsset(env, latest.downloadUrl);
  const sha256 = await computeSha256Hex(bytes);

  await putFirmwareBinary(env, latest.version, bytes);
  await env.DB.prepare(
    `INSERT INTO firmware_releases (version, tag, sha256, size_bytes, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(latest.version, latest.tag, sha256, bytes.byteLength, latest.downloadUrl, Math.floor(Date.now() / 1000))
    .run();

  return { version: latest.version, isNew: true };
}

export function registerAdminFirmwareRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/firmware/sync", requireAdmin, async (c) => {
    try {
      const result = await syncLatestFirmwareRelease(c.env);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/admin/firmware/releases", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT version, tag, sha256, size_bytes, created_at FROM firmware_releases ORDER BY created_at DESC"
    ).all();
    return c.json({ releases: rows.results });
  });

  // Exact override rows for every target, so the UI can show current state before editing.
  app.get("/admin/firmware/targets", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare("SELECT target, version, updated_at FROM firmware_targets").all();
    return c.json({ targets: rows.results });
  });

  app.put("/admin/firmware/target/:target", requireAdmin, async (c) => {
    const target = c.req.param("target");
    if (!target) return c.json({ error: "target is required" }, 400);
    if (!(await assertTargetOwnership(c.env, target, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json<{ version?: string }>().catch(() => ({}) as never);
    if (!body.version) return c.json({ error: "version is required" }, 400);

    const release = await c.env.DB.prepare("SELECT version FROM firmware_releases WHERE version = ?")
      .bind(body.version)
      .first();
    if (!release) return c.json({ error: `Unknown firmware version ${body.version}` }, 400);

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO firmware_targets (target, version, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`
    )
      .bind(target, body.version, now)
      .run();

    await invalidateFirmwareTargetCache(c.env, target);
    return c.json({ target, version: body.version });
  });

  app.delete("/admin/firmware/target/:target", requireAdmin, async (c) => {
    const target = c.req.param("target");
    if (!target) return c.json({ error: "target is required" }, 400);
    if (!(await assertTargetOwnership(c.env, target, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const result = await c.env.DB.prepare("DELETE FROM firmware_targets WHERE target = ?").bind(target).run();
    await invalidateFirmwareTargetCache(c.env, target);
    return c.json({ cleared: target, existed: (result.meta.changes ?? 0) > 0 });
  });
}
