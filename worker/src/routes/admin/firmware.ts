import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { fetchLatestGitHubRelease, resolveBoardAsset, downloadFirmwareAsset, KNOWN_BOARDS } from "../../lib/github-release";
import type { GitHubRelease } from "../../lib/github-release";
import { computeSha256Hex, putFirmwareBinary } from "../../lib/firmware-store";
import { invalidateFirmwareTargetCache, type FirmwareChannel } from "../../lib/firmware-target";

const FIRMWARE_CHANNELS: FirmwareChannel[] = ["stable", "beta"];

/** Same ownership model as admin/schedule.ts's assertTargetOwnership: every target
 *  must be a device MAC owned by the caller — no shared 'default'/'global' tier. */
async function assertTargetOwnership(env: Env, target: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT user_id FROM devices WHERE mac = ?")
    .bind(target)
    .first<{ user_id: string | null }>();
  return row?.user_id === userId;
}

/**
 * Pulls one board's asset out of an already-fetched GitHub release into the
 * worker's own catalog (D1 metadata + KV blob). Devices on the 'stable'
 * channel start receiving this as soon as it's cataloged — there's no
 * separate "roll it out" step anymore (see lib/firmware-target.ts's
 * resolveFirmwareTarget). `null` means this board has no asset in this
 * release (not an error — see resolveBoardAsset).
 */
async function syncBoardRelease(
  env: Env,
  board: string,
  release: GitHubRelease
): Promise<{ version: string; isNew: boolean } | null> {
  const latest = resolveBoardAsset(release, board);
  if (!latest) return null;

  const existing = await env.DB.prepare("SELECT version FROM firmware_releases WHERE board = ? AND version = ?")
    .bind(board, latest.version)
    .first();
  if (existing) return { version: latest.version, isNew: false };

  const bytes = await downloadFirmwareAsset(env, latest.downloadUrl);
  const sha256 = await computeSha256Hex(bytes);

  await putFirmwareBinary(env, board, latest.version, bytes);
  await env.DB.prepare(
    `INSERT INTO firmware_releases (board, version, tag, sha256, size_bytes, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(board, latest.version, latest.tag, sha256, bytes.byteLength, latest.downloadUrl, Math.floor(Date.now() / 1000))
    .run();

  return { version: latest.version, isNew: true };
}

/**
 * Syncs every known board's asset from the latest GitHub release. Shared
 * between the manual /admin/firmware/sync route and index.ts's scheduled()
 * cron handler, so "let Cloudflare pick up new releases" works without a
 * click. A board with no asset in this release is skipped, not a failure for
 * the others — see syncBoardRelease. Fetches the release once and reuses it
 * across every board, rather than one GitHub API call per board.
 */
export async function syncLatestFirmwareRelease(
  env: Env
): Promise<Record<string, { version: string; isNew: boolean } | null>> {
  const release = await fetchLatestGitHubRelease(env);
  const results: Record<string, { version: string; isNew: boolean } | null> = {};
  for (const board of KNOWN_BOARDS) {
    results[board] = await syncBoardRelease(env, board, release);
  }
  return results;
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
      "SELECT board, version, tag, sha256, size_bytes, created_at FROM firmware_releases ORDER BY created_at DESC"
    ).all();
    return c.json({ releases: rows.results });
  });

  // Current channel for every target, so the UI can show state before editing.
  app.get("/admin/firmware/targets", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare("SELECT target, channel, updated_at FROM firmware_targets").all();
    return c.json({ targets: rows.results });
  });

  app.put("/admin/firmware/target/:target", requireAdmin, async (c) => {
    const target = c.req.param("target");
    if (!target) return c.json({ error: "target is required" }, 400);
    if (!(await assertTargetOwnership(c.env, target, c.var.user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json<{ channel?: string }>().catch(() => ({}) as never);
    if (!body.channel || !FIRMWARE_CHANNELS.includes(body.channel as FirmwareChannel)) {
      return c.json({ error: `channel must be one of: ${FIRMWARE_CHANNELS.join(", ")}` }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO firmware_targets (target, channel, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET channel = excluded.channel, updated_at = excluded.updated_at`
    )
      .bind(target, body.channel, now)
      .run();

    await invalidateFirmwareTargetCache(c.env, target);
    return c.json({ target, channel: body.channel });
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
