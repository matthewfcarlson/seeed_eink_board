import type { Env } from "../types";
import type { DeviceAlert } from "./device-health";
import { alertsText } from "./notify";

/**
 * Email delivery for device health alerts (migrations/0025_notification_emails.sql),
 * via Cloudflare Email Service's `send_email` binding (env.EMAIL). Optional:
 * with no binding or no EMAIL_FROM configured, the feature reports itself
 * unavailable and the admin UI hides the add form.
 */

export const MAX_EMAILS_PER_USER = 3;
/** RFC 5321's practical ceiling for a forward-path address. */
const MAX_EMAIL_LENGTH = 254;
export const VERIFY_TOKEN_TTL_SECONDS = 24 * 3600;
const MAX_ERROR_LENGTH = 200;

// Deliberately conservative: one @, no whitespace/control chars, no
// characters that mean something in a header ("<>,;:\"()[]\\"), and a dotted
// domain. Real validation is the confirmation email.
const EMAIL_PATTERN = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

export function emailAlertsAvailable(env: Env): boolean {
  return !!env.EMAIL && !!env.EMAIL_FROM;
}

/** Normalized (trimmed, lowercased) address, or null if it isn't one. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The origin links in emails point at. Admin routes pass their own request
 *  origin; the cron has no request, so it needs PUBLIC_BASE_URL. */
export function publicBaseUrl(env: Env, requestUrl?: string): string | null {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return requestUrl ? new URL(requestUrl).origin : null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Device labels are free text — keep CR/LF (header injection) and other
 *  control characters out of the Subject. */
function headerSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function alertSubject(alerts: DeviceAlert[]): string {
  const a = alerts[0]!;
  const name = a.label || a.mac;
  const first = {
    offline: `${name} is offline`,
    still_offline: `${name} is still offline`,
    back_online: `${name} is back online`,
    low_battery: `${name}'s battery is low`,
    battery_ok: `${name}'s battery is charged`,
  }[a.kind];
  const more = alerts.length > 1 ? ` (+${alerts.length - 1} more)` : "";
  return headerSafe(`E-Ink frame: ${first}${more}`).slice(0, 200);
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

function layoutHtml(paragraphs: string[], footer: string): string {
  return (
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:560px;">' +
    paragraphs.map((p) => '<p style="margin:0 0 12px;">' + p + "</p>").join("") +
    '<p style="margin:24px 0 0;font-size:12px;color:#777;">' + footer + "</p></div>"
  );
}

export function buildAlertEmail(
  alerts: DeviceAlert[],
  now: number,
  baseUrl: string,
  unsubscribeToken: string,
  opts: { test?: boolean } = {}
): EmailContent {
  const lines = alertsText(alerts, now).split("\n");
  const adminUrl = baseUrl + "/admin";
  const unsubscribeUrl = baseUrl + "/notifications/email/unsubscribe?token=" + encodeURIComponent(unsubscribeToken);
  const intro = opts.test ? ["This is a test alert. Real alerts look like this:"] : [];
  const subject = opts.test ? "E-Ink frame: test alert" : alertSubject(alerts);

  const text =
    [...intro, ...lines].join("\n") +
    `\n\nManage your frames and alerts: ${adminUrl}\nStop these emails: ${unsubscribeUrl}\n`;
  const html = layoutHtml(
    [...intro, ...lines].map(escapeHtml),
    `<a href="${escapeHtml(adminUrl)}">Manage your frames and alerts</a> · ` +
      `<a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a>`
  );
  // RFC 2369/8058 one-click unsubscribe (Gmail/Yahoo want it; Email Service
  // rejects a non-https URI, so local http dev just goes without).
  const headers: Record<string, string> = unsubscribeUrl.startsWith("https://")
    ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : {};
  return { subject, text, html, headers };
}

export function buildVerificationEmail(baseUrl: string, token: string): EmailContent {
  const confirmUrl = baseUrl + "/notifications/email/verify?token=" + encodeURIComponent(token);
  const text =
    "Someone (hopefully you) asked to send alerts about their E-Ink picture frames to this address — " +
    "when a frame stops checking in or its battery runs low.\n\n" +
    `Confirm: ${confirmUrl}\n\n` +
    "The link works for 24 hours. If this wasn't you, ignore this email and nothing more will be sent.\n";
  const html = layoutHtml(
    [
      "Someone (hopefully you) asked to send alerts about their E-Ink picture frames to this address &mdash; when a frame stops checking in or its battery runs low.",
      `<a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:10px 18px;background:#2f6f8f;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Confirm this address</a>`,
    ],
    "The link works for 24 hours. If this wasn't you, ignore this email and nothing more will be sent."
  );
  return { subject: "Confirm E-Ink frame alerts", text, html, headers: {} };
}

/** Sends one email. Never throws; returns an error message on failure. */
export async function sendEmail(env: Env, to: string, content: EmailContent): Promise<string | null> {
  if (!env.EMAIL || !env.EMAIL_FROM) return "Email sending isn't configured on this server";
  try {
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: "E-Ink Frame" },
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      ...(Object.keys(content.headers).length ? { headers: content.headers } : {}),
    });
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return String((e.code ? e.code + ": " : "") + (e.message ?? err)).slice(0, MAX_ERROR_LENGTH);
  }
}

export interface EmailRecipientRow {
  id: string;
  email: string;
  unsubscribe_token: string;
}

/** Sends one alert email to a verified recipient without recording anything.
 *  Never throws; returns an error message on failure. */
export function sendAlertEmail(
  env: Env,
  recipient: EmailRecipientRow,
  alerts: DeviceAlert[],
  now: number,
  baseUrl: string,
  opts: { test?: boolean } = {}
): Promise<string | null> {
  return sendEmail(env, recipient.email, buildAlertEmail(alerts, now, baseUrl, recipient.unsubscribe_token, opts));
}

/** The statement recording a delivery outcome on the recipient's row — the
 *  cron batches these into one D1 call instead of a query per delivery. */
export function emailResultStatement(env: Env, recipientId: string, now: number, error: string | null): D1PreparedStatement {
  return env.DB.prepare("UPDATE notification_emails SET last_attempt_at = ?, last_error = ? WHERE id = ?").bind(
    now,
    error,
    recipientId
  );
}

/** Sends one alert email to a verified recipient and records the outcome. */
export async function deliverAlertEmail(
  env: Env,
  recipient: EmailRecipientRow,
  alerts: DeviceAlert[],
  now: number,
  baseUrl: string,
  opts: { test?: boolean } = {}
): Promise<string | null> {
  const error = await sendAlertEmail(env, recipient, alerts, now, baseUrl, opts);
  await emailResultStatement(env, recipient.id, now, error)
    .run()
    .catch((err) => console.error("Failed to record email delivery result:", err));
  return error;
}
