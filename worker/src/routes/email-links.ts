import type { Context, Hono } from "hono";
import type { Env } from "../types";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "../lib/rate-limit";
import { VERIFY_TOKEN_TTL_SECONDS, sha256Hex } from "../lib/email-alerts";

/**
 * Public, unauthenticated pages behind the links in alert emails (see
 * lib/email-alerts.ts) — the token in the link is the only credential.
 *
 * GET never changes anything: it renders a page with a button that POSTs.
 * Corporate mail scanners (Outlook Safe Links, etc.) pre-fetch every link in
 * an email, so a GET-to-confirm would let anyone "verify" a victim's address
 * and start mailing them. The one exception to needing a click is RFC 8058
 * one-click unsubscribe, which is itself a POST from the mail client.
 */

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · E-Ink Frame</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<div class="page page-narrow" style="max-width:460px; margin:64px auto 0;">
  <div class="card">
    <h2>${title}</h2>
    ${body}
  </div>
</div>
</body>
</html>`;
}

function htmlResponse(c: Context<{ Bindings: Env }>, html: string, status = 200) {
  // Tokens live in the URL: keep them out of caches and Referer headers.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(html, status as 200);
}

function tokenForm(action: string, token: string, button: string): string {
  const escaped = token.replace(/[^A-Za-z0-9_-]/g, "");
  return `<form method="POST" action="${action}?token=${escaped}"><button type="submit">${button}</button></form>`;
}

async function withinRateLimit(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const limits = RATE_LIMITS.emailLink;
  return checkRateLimit(c.env, "emailLink", ip, limits.limit, limits.windowSeconds);
}

export function registerEmailLinkRoutes(app: Hono<{ Bindings: Env }>) {
  app.get("/notifications/email/verify", (c) => {
    const token = c.req.query("token") ?? "";
    return htmlResponse(
      c,
      page(
        "Confirm email alerts",
        `<p class="hint hint-block">Confirm to receive emails when E-Ink picture frames stop checking in or run low on battery. You can unsubscribe from any alert email.</p>` +
          tokenForm("/notifications/email/verify", token, "Confirm this address")
      )
    );
  });

  app.post("/notifications/email/verify", async (c) => {
    if (!(await withinRateLimit(c))) return rateLimitedResponse(RATE_LIMITS.emailLink.windowSeconds);
    const token = c.req.query("token") ?? "";
    const now = Math.floor(Date.now() / 1000);
    const row = token
      ? await c.env.DB.prepare(
          "SELECT id, email, verify_sent_at FROM notification_emails WHERE verify_token_hash = ? AND verified_at IS NULL"
        )
          .bind(await sha256Hex(token))
          .first<{ id: string; email: string; verify_sent_at: number }>()
      : null;
    if (!row || now - row.verify_sent_at > VERIFY_TOKEN_TTL_SECONDS) {
      return htmlResponse(
        c,
        page(
          "Link expired",
          `<p class="hint hint-block">This confirmation link is invalid, already used, or more than 24 hours old. Use "Resend" next to the address in the Alerts section of your admin page to get a new one.</p>`
        ),
        400
      );
    }
    await c.env.DB.prepare(
      "UPDATE notification_emails SET verified_at = ?, verify_token_hash = NULL WHERE id = ?"
    )
      .bind(now, row.id)
      .run();
    return htmlResponse(
      c,
      page(
        "You're all set",
        `<p class="hint hint-block">Frame alerts will now be emailed to <strong>${row.email.replace(/[<>&"']/g, "")}</strong>.</p>`
      )
    );
  });

  app.get("/notifications/email/unsubscribe", (c) => {
    const token = c.req.query("token") ?? "";
    return htmlResponse(
      c,
      page(
        "Unsubscribe",
        `<p class="hint hint-block">Stop sending E-Ink frame alerts to this address?</p>` +
          tokenForm("/notifications/email/unsubscribe", token, "Unsubscribe")
      )
    );
  });

  // Both the page's button and RFC 8058 one-click (the mail client POSTs
  // `List-Unsubscribe=One-Click` to the List-Unsubscribe URL) land here.
  app.post("/notifications/email/unsubscribe", async (c) => {
    if (!(await withinRateLimit(c))) return rateLimitedResponse(RATE_LIMITS.emailLink.windowSeconds);
    const token = c.req.query("token") ?? "";
    if (token) {
      // Deleted, not flagged — this is the only place the address is stored.
      await c.env.DB.prepare("DELETE FROM notification_emails WHERE unsubscribe_token = ?").bind(token).run();
    }
    // Same answer whether or not the token matched: an unsubscribe link
    // shouldn't confirm which tokens exist, and repeating one is harmless.
    return htmlResponse(
      c,
      page(
        "Unsubscribed",
        `<p class="hint hint-block">This address won't get any more frame alerts. The frame's owner can add it again from their admin page.</p>`
      )
    );
  });
}
