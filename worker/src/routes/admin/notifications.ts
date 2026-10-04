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
import {
  MAX_EMAILS_PER_USER,
  buildVerificationEmail,
  deliverAlertEmail,
  emailAlertsAvailable,
  normalizeEmail,
  publicBaseUrl,
  randomToken,
  sendEmail,
  sha256Hex,
  type EmailRecipientRow,
} from "../../lib/email-alerts";

/** Shown by both test endpoints — one alert of each urgent kind. */
function sampleAlerts(now: number): DeviceAlert[] {
  return [
    { kind: "offline", mac: "aabbccddeeff", label: "Kitchen frame", lastSeenAt: now - 26 * 3600, batteryVoltage: 3.41 },
    { kind: "low_battery", mac: "112233445566", label: "Hallway frame", lastSeenAt: now - 600, batteryVoltage: 3.48 },
  ];
}

export const MAX_WEBHOOK_LABEL = 80;

/**
 * Owner-managed alert webhooks (see migrations/0025_device_alerts.sql). The
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
    const result = await deliverWebhook(c.env, hook, sampleAlerts(now), now, { test: true });
    return c.json(result, result.ok ? 200 : 502);
  });

  // ---- Email (migrations/0026_notification_emails.sql) ----
  // Addresses are added unverified and get exactly one kind of email — the
  // confirmation link — until the recipient confirms on the public page
  // (routes/email-links.ts). Every caller-triggered send shares the tight
  // emailSend limit, since the recipient may not have asked for it.

  app.get("/admin/notifications/emails", requireAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT id, email, verified_at, verify_sent_at, created_at, last_attempt_at, last_error
       FROM notification_emails WHERE user_id = ? ORDER BY created_at ASC`
    )
      .bind(c.var.user.id)
      .all();
    return c.json({ available: emailAlertsAvailable(c.env), emails: rows.results });
  });

  app.post("/admin/notifications/emails", requireAdmin, async (c) => {
    if (!emailAlertsAvailable(c.env)) return c.json({ error: "Email alerts aren't configured on this server" }, 503);
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as never);
    const email = normalizeEmail(body.email);
    if (!email) return c.json({ error: "That doesn't look like an email address" }, 400);

    const existing = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(email = ?) AS dup FROM notification_emails WHERE user_id = ?"
    )
      .bind(email, c.var.user.id)
      .first<{ n: number; dup: number | null }>();
    if (existing?.dup) return c.json({ error: "That address is already added" }, 409);
    if ((existing?.n ?? 0) >= MAX_EMAILS_PER_USER) {
      return c.json({ error: `At most ${MAX_EMAILS_PER_USER} email addresses per account` }, 409);
    }
    const limits = RATE_LIMITS.emailSend;
    if (!(await checkRateLimit(c.env, "emailSend", c.var.user.id, limits.limit, limits.windowSeconds))) {
      return rateLimitedResponse(limits.windowSeconds);
    }

    const id = crypto.randomUUID();
    const token = randomToken();
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO notification_emails (id, user_id, email, verify_token_hash, verify_sent_at, unsubscribe_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, c.var.user.id, email, await sha256Hex(token), now, randomToken(), now)
      .run();

    const error = await sendEmail(c.env, email, buildVerificationEmail(publicBaseUrl(c.env, c.req.url)!, token));
    if (error) {
      // Don't leave a row nobody can ever confirm.
      await c.env.DB.prepare("DELETE FROM notification_emails WHERE id = ?").bind(id).run();
      return c.json({ error: "Couldn't send the confirmation email: " + error }, 502);
    }
    return c.json({ id, email, verified_at: null, verify_sent_at: now, created_at: now }, 201);
  });

  app.post("/admin/notifications/emails/:id/resend", requireAdmin, async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT id, email, verified_at FROM notification_emails WHERE id = ? AND user_id = ?"
    )
      .bind(c.req.param("id"), c.var.user.id)
      .first<{ id: string; email: string; verified_at: number | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.verified_at) return c.json({ error: "Already confirmed" }, 409);
    const limits = RATE_LIMITS.emailSend;
    if (!(await checkRateLimit(c.env, "emailSend", c.var.user.id, limits.limit, limits.windowSeconds))) {
      return rateLimitedResponse(limits.windowSeconds);
    }
    const token = randomToken();
    const now = Math.floor(Date.now() / 1000);
    // A resend invalidates the previous link.
    await c.env.DB.prepare("UPDATE notification_emails SET verify_token_hash = ?, verify_sent_at = ? WHERE id = ?")
      .bind(await sha256Hex(token), now, row.id)
      .run();
    const error = await sendEmail(c.env, row.email, buildVerificationEmail(publicBaseUrl(c.env, c.req.url)!, token));
    if (error) return c.json({ error: "Couldn't send the confirmation email: " + error }, 502);
    return c.json({ ok: true });
  });

  app.post("/admin/notifications/emails/:id/test", requireAdmin, async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT id, email, unsubscribe_token, verified_at FROM notification_emails WHERE id = ? AND user_id = ?"
    )
      .bind(c.req.param("id"), c.var.user.id)
      .first<EmailRecipientRow & { verified_at: number | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (!row.verified_at) return c.json({ error: "Confirm this address first — check its inbox" }, 409);
    const limits = RATE_LIMITS.emailSend;
    if (!(await checkRateLimit(c.env, "emailSend", c.var.user.id, limits.limit, limits.windowSeconds))) {
      return rateLimitedResponse(limits.windowSeconds);
    }
    const now = Math.floor(Date.now() / 1000);
    const error = await deliverAlertEmail(c.env, row, sampleAlerts(now), now, publicBaseUrl(c.env, c.req.url)!, {
      test: true,
    });
    return c.json({ ok: !error, error }, error ? 502 : 200);
  });

  app.delete("/admin/notifications/emails/:id", requireAdmin, async (c) => {
    const result = await c.env.DB.prepare("DELETE FROM notification_emails WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id"), c.var.user.id)
      .run();
    if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });
}
