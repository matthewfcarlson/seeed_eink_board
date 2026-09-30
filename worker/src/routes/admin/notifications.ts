import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "../../lib/rate-limit";
import { validateLabel } from "../../lib/validate";
import type { DeviceAlert } from "../../lib/device-health";
import {
  MAX_WEBHOOKS_PER_USER,
  deliverWebhook,
  generateSigningSecret,
  isWebhookFormat,
  maskWebhookUrl,
  validateWebhookUrl,
  type WebhookRow,
} from "../../lib/notify";

export const MAX_WEBHOOK_LABEL = 80;

/**
 * Owner-managed alert webhooks (see migrations/0024_device_alerts.sql). The
 * URL itself is write-only from the API's point of view — list responses
 * carry a masked preview, since Slack/Discord URLs embed their own token.
 * signing_secret is returned exactly once, from the create call.
 */
export function registerAdminNotificationRoutes(app: Hono<{ Bindings: Env }>) {
  app.get("/admin/notifications/webhooks", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT id, url, format, label, created_at, last_attempt_at, last_status, last_error
       FROM notification_webhooks WHERE user_id = ? ORDER BY created_at ASC`
    )
      .bind(c.var.user.id)
      .all<{ id: string; url: string; format: string; label: string | null } & Record<string, unknown>>();
    return c.json({
      webhooks: rows.results.map(({ url, ...rest }) => ({ ...rest, url_preview: maskWebhookUrl(url) })),
    });
  });

  app.post("/admin/notifications/webhooks", requireAdmin, async (c) => {
    const body = await c.req
      .json<{ url?: unknown; format?: unknown; label?: unknown }>()
      .catch(() => ({}) as never);
    const url = validateWebhookUrl(body.url);
    if (!url) return c.json({ error: "url must be an https:// URL (no embedded username/password)" }, 400);
    if (!isWebhookFormat(body.format)) {
      return c.json({ error: "format must be one of json, slack, discord, ntfy" }, 400);
    }
    let label: string | null = null;
    if (body.label !== undefined && body.label !== null && body.label !== "") {
      label = validateLabel(body.label, MAX_WEBHOOK_LABEL);
      if (!label) return c.json({ error: `label must be at most ${MAX_WEBHOOK_LABEL} characters` }, 400);
    }

    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notification_webhooks WHERE user_id = ?")
      .bind(c.var.user.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_WEBHOOKS_PER_USER) {
      return c.json({ error: `At most ${MAX_WEBHOOKS_PER_USER} webhooks per account` }, 409);
    }

    const id = crypto.randomUUID();
    const signingSecret = generateSigningSecret();
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO notification_webhooks (id, user_id, url, format, label, signing_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, c.var.user.id, url, body.format, label, signingSecret, now)
      .run();

    return c.json(
      { id, format: body.format, label, url_preview: maskWebhookUrl(url), signing_secret: signingSecret, created_at: now },
      201
    );
  });

  app.delete("/admin/notifications/webhooks/:id", requireAdmin, async (c) => {
    const result = await c.env.DB.prepare("DELETE FROM notification_webhooks WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id"), c.var.user.id)
      .run();
    if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // Sends a sample alert so the owner can confirm the wiring end to end. Its
  // own tight rate limit on top of the admin one — each call is an outbound
  // POST to an arbitrary URL of the caller's choosing.
  app.post("/admin/notifications/webhooks/:id/test", requireAdmin, async (c) => {
    const limits = RATE_LIMITS.webhookTest;
    if (!(await checkRateLimit(c.env, "webhookTest", c.var.user.id, limits.limit, limits.windowSeconds))) {
      return rateLimitedResponse(limits.windowSeconds);
    }
    const hook = await c.env.DB.prepare(
      "SELECT id, url, format, signing_secret FROM notification_webhooks WHERE id = ? AND user_id = ?"
    )
      .bind(c.req.param("id"), c.var.user.id)
      .first<WebhookRow>();
    if (!hook) return c.json({ error: "Not found" }, 404);

    const now = Math.floor(Date.now() / 1000);
    const sample: DeviceAlert[] = [
      { kind: "offline", mac: "aabbccddeeff", label: "Kitchen frame", lastSeenAt: now - 5 * 3600, batteryVoltage: 3.41 },
      { kind: "low_battery", mac: "112233445566", label: "Hallway frame", lastSeenAt: now - 600, batteryVoltage: 3.48 },
    ];
    const result = await deliverWebhook(c.env, hook, sample, now, { test: true });
    return c.json(result, result.ok ? 200 : 502);
  });
}
