import type { Env } from "../types";
import type { DeviceAlert } from "./device-health";

/**
 * Owner-registered webhook delivery for device health alerts (see
 * migrations/0025_device_alerts.sql). One POST per webhook per check, listing
 * every alert for that owner's devices — never one message per device.
 */

export const WEBHOOK_FORMATS = ["json", "slack", "discord", "ntfy"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const MAX_WEBHOOK_URL = 2048;
export const MAX_WEBHOOKS_PER_USER = 5;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 200;
const DISCORD_CONTENT_LIMIT = 2000;
/** An offline device whose last reading was below this most likely died of a
 *  flat battery rather than losing WiFi — only changes the message's hint. */
const DEAD_BATTERY_HINT_VOLTAGE = 3.6;

export interface WebhookRow {
  id: string;
  url: string;
  format: WebhookFormat;
  signing_secret: string;
}

export function isWebhookFormat(value: unknown): value is WebhookFormat {
  return typeof value === "string" && (WEBHOOK_FORMATS as readonly string[]).includes(value);
}

/**
 * https only (the URL frequently carries its own bearer token — Slack,
 * Discord, a private ntfy topic — so never send it in the clear), no embedded
 * credentials, bounded length. Returns the normalized URL or null.
 */
export function validateWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WEBHOOK_URL) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
  return url.toString();
}

/** What the admin API shows instead of the URL itself: scheme + host + a hint
 *  of the path's tail, enough to tell two webhooks apart without exposing the
 *  token that Slack/Discord embed in the path. */
export function maskWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    const tail = path.length > 4 ? "…" + path.slice(-4) : path;
    return url.protocol + "//" + url.host + tail;
  } catch {
    return "(invalid URL)";
  }
}

function deviceName(a: DeviceAlert): string {
  return a.label || a.mac;
}

function durationSince(epoch: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - epoch) / 60));
  if (minutes < 90) return minutes + " minutes";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + " hours";
  return Math.round(hours / 24) + " days";
}

/** One human-readable line per alert — shared by every format. */
export function describeAlert(a: DeviceAlert, now: number): string {
  const name = deviceName(a);
  const volts = a.batteryVoltage != null && a.batteryVoltage > 0 ? a.batteryVoltage.toFixed(2) + "V" : null;
  switch (a.kind) {
    case "offline": {
      const since = a.lastSeenAt != null ? " for " + durationSince(a.lastSeenAt, now) : "";
      // The last voltage reading is the best hint at *why*: a device that went
      // quiet near empty almost certainly died; one with plenty left more
      // likely lost WiFi or power.
      const why =
        volts == null
          ? ""
          : a.batteryVoltage! < DEAD_BATTERY_HINT_VOLTAGE
          ? ` Last battery reading was ${volts}, so it has probably run out of charge.`
          : ` Its last battery reading was ${volts}, so check its WiFi or power.`;
      return `⚠️ ${name} hasn't checked in${since}.${why}`;
    }
    case "still_offline": {
      const since = a.lastSeenAt != null ? " It hasn't checked in for " + durationSince(a.lastSeenAt, now) + "." : "";
      return `⏰ ${name} is still offline.${since}`;
    }
    case "back_online":
      return `✅ ${name} is checking in again.`;
    case "low_battery":
      return `🔋 ${name}'s battery is low${volts ? " (" + volts + ")" : ""}. Charge it soon.`;
    case "battery_ok":
      return `✅ ${name}'s battery is charged again${volts ? " (" + volts + ")" : ""}.`;
  }
}

export function alertsText(alerts: DeviceAlert[], now: number): string {
  return alerts.map((a) => describeAlert(a, now)).join("\n");
}

/** Slack mrkdwn treats <...> as links/mentions (`<!channel>`); escape so a
 *  device label can't ping a whole channel. */
function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function hmacHex(secretHex: string, message: string): Promise<string> {
  const keyBytes = new Uint8Array(secretHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateSigningSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The request for one webhook. `json` is the structured, signed format for
 * custom receivers (Home Assistant, n8n, your own script): verify with
 * HMAC-SHA256(signing_secret, `${X-Eink-Timestamp}.${raw body}`) ==
 * X-Eink-Signature's hex after "sha256=". The others are shaped for their
 * service's incoming-webhook API and carry the same text.
 */
export async function buildWebhookRequest(
  hook: Pick<WebhookRow, "url" | "format" | "signing_secret">,
  alerts: DeviceAlert[],
  now: number,
  opts: { test?: boolean } = {}
): Promise<Request> {
  const text = opts.test
    ? "👋 Test alert from your E-Ink picture frame server. Real alerts look like:\n" + alertsText(alerts, now)
    : alertsText(alerts, now);
  const headers: Record<string, string> = {};
  let body: string;

  switch (hook.format) {
    case "slack":
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ text: slackEscape(text) });
      break;
    case "discord":
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        content: text.length > DISCORD_CONTENT_LIMIT ? text.slice(0, DISCORD_CONTENT_LIMIT - 1) + "…" : text,
        // A label like "@everyone" must not ping the server.
        allowed_mentions: { parse: [] },
      });
      break;
    case "ntfy": {
      headers["Content-Type"] = "text/plain; charset=utf-8";
      // Header values must stay ASCII — labels live only in the body.
      headers["Title"] = opts.test ? "E-Ink frame: test alert" : "E-Ink frame alert";
      const urgent = alerts.some((a) => a.kind === "offline" || a.kind === "still_offline" || a.kind === "low_battery");
      headers["Tags"] = urgent ? "warning" : "white_check_mark";
      headers["Priority"] = urgent && !opts.test ? "high" : "default";
      body = text;
      break;
    }
    case "json":
    default: {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        type: opts.test ? "test" : "device_alerts",
        sent_at: now,
        text,
        alerts: alerts.map((a) => ({
          kind: a.kind,
          device: { mac: a.mac, label: a.label },
          last_seen_at: a.lastSeenAt,
          battery_voltage: a.batteryVoltage,
        })),
      });
      const timestamp = String(now);
      headers["X-Eink-Timestamp"] = timestamp;
      headers["X-Eink-Signature"] = "sha256=" + (await hmacHex(hook.signing_secret, timestamp + "." + body));
      break;
    }
  }

  return new Request(hook.url, { method: "POST", headers, body });
}

export interface DeliveryResult {
  ok: boolean;
  status: number; // 0 = no HTTP response (network error / timeout)
  error: string | null;
}

/** Sends one webhook without recording anything. Never throws. */
export async function sendWebhook(
  hook: WebhookRow,
  alerts: DeviceAlert[],
  now: number,
  opts: { test?: boolean } = {}
): Promise<DeliveryResult> {
  let result: DeliveryResult;
  try {
    const req = await buildWebhookRequest(hook, alerts, now, opts);
    const res = await fetch(req, { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
    if (res.ok) {
      result = { ok: true, status: res.status, error: null };
    } else {
      const detail = (await res.text().catch(() => "")).trim().slice(0, MAX_ERROR_LENGTH);
      result = { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? ": " + detail : ""}` };
    }
    // Drain so the connection is released even when we didn't read the body.
    if (res.ok) await res.body?.cancel();
  } catch (err) {
    result = { ok: false, status: 0, error: String((err as Error)?.message ?? err).slice(0, MAX_ERROR_LENGTH) };
  }
  return result;
}

/** The statement recording a delivery outcome on the webhook's row — the
 *  cron batches these into one D1 call instead of a query per delivery. */
export function webhookResultStatement(env: Env, hookId: string, now: number, result: DeliveryResult): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE notification_webhooks SET last_attempt_at = ?, last_status = ?, last_error = ? WHERE id = ?"
  ).bind(now, result.status, result.error, hookId);
}

/** Sends one webhook and records the outcome on its row. Never throws. */
export async function deliverWebhook(
  env: Env,
  hook: WebhookRow,
  alerts: DeviceAlert[],
  now: number,
  opts: { test?: boolean } = {}
): Promise<DeliveryResult> {
  const result = await sendWebhook(hook, alerts, now, opts);
  await webhookResultStatement(env, hook.id, now, result)
    .run()
    .catch((err) => console.error("Failed to record webhook delivery result:", err));
  return result;
}
