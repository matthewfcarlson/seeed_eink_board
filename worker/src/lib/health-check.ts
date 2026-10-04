import type { Env } from "../types";
import { evaluateDeviceHealth, planDeviceAlerts, type DeviceAlert } from "./device-health";
import { kvKeys } from "./kv-keys";
import { deliverWebhook, type WebhookRow } from "./notify";
import { deliverAlertEmail, emailAlertsAvailable, publicBaseUrl, type EmailRecipientRow } from "./email-alerts";

interface DeviceRow {
  mac: string;
  user_id: string;
  label: string | null;
  last_seen_at: number;
  last_battery_voltage: number | null;
  offline_alerted_at: number | null;
  low_battery_alerted_at: number | null;
}

/**
 * Hourly (index.ts's scheduled()): evaluate every registered, un-muted device,
 * persist alert-state transitions, then send one batched message per owner to
 * each of their webhooks and verified email addresses.
 *
 * D1's offline_alerted_at is the source of truth for "the owner knows it's
 * offline" (and so owes a recovery message). "Still offline" follow-ups are
 * paced by a KV key armed with a TTL (weekly, then monthly — see
 * device-health.ts's reminderIntervalSeconds): once it expires, the next
 * hourly run sends a reminder and re-arms it. Losing the key early costs at
 * most one extra reminder.
 *
 * State is written *before* delivery and regardless of its outcome: a broken
 * webhook URL shows up as last_error in /admin rather than re-sending the same
 * alert every hour forever. The tradeoff is that an alert whose delivery
 * failed isn't retried — the next reminder or recovery is still sent.
 */
export async function runDeviceHealthCheck(env: Env, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT mac, user_id, label, last_seen_at, last_battery_voltage, offline_alerted_at, low_battery_alerted_at
     FROM devices
     WHERE user_id IS NOT NULL AND secret IS NOT NULL
       AND last_seen_at IS NOT NULL AND alerts_muted = 0`
  ).all<DeviceRow>();

  const alertsByUser = new Map<string, DeviceAlert[]>();
  const updates: D1PreparedStatement[] = [];
  const kvOps: Promise<void>[] = [];
  for (const row of rows.results) {
    const input = {
      mac: row.mac,
      label: row.label,
      lastSeenAt: row.last_seen_at,
      batteryVoltage: row.last_battery_voltage,
      offlineAlertedAt: row.offline_alerted_at,
      lowBatteryAlertedAt: row.low_battery_alerted_at,
    };
    // Only devices already alerted as offline and still offline need their
    // reminder key — skip the KV read for everything else.
    const reminderDue =
      row.offline_alerted_at != null && evaluateDeviceHealth(input, now).offline
        ? (await env.KV.get(kvKeys.offlineReminder(row.mac))) === null
        : false;
    const plan = planDeviceAlerts(input, now, reminderDue);
    if (plan.alerts.length === 0) continue;

    if (plan.offlineAlertedAt !== row.offline_alerted_at || plan.lowBatteryAlertedAt !== row.low_battery_alerted_at) {
      updates.push(
        env.DB.prepare("UPDATE devices SET offline_alerted_at = ?, low_battery_alerted_at = ? WHERE mac = ?").bind(
          plan.offlineAlertedAt,
          plan.lowBatteryAlertedAt,
          row.mac
        )
      );
    }
    if (plan.armReminderSeconds !== null) {
      kvOps.push(
        env.KV.put(kvKeys.offlineReminder(row.mac), String(now), { expirationTtl: plan.armReminderSeconds })
      );
    } else if (plan.clearReminder) {
      kvOps.push(env.KV.delete(kvKeys.offlineReminder(row.mac)));
    }
    const list = alertsByUser.get(row.user_id) ?? [];
    list.push(...plan.alerts);
    alertsByUser.set(row.user_id, list);
  }

  if (alertsByUser.size === 0) return;
  if (updates.length > 0) await env.DB.batch(updates);
  await Promise.all(kvOps);

  const userIds = [...alertsByUser.keys()];
  const placeholders = userIds.map(() => "?").join(",");
  const hooks = await env.DB.prepare(
    `SELECT id, user_id, url, format, signing_secret FROM notification_webhooks WHERE user_id IN (${placeholders})`
  )
    .bind(...userIds)
    .all<WebhookRow & { user_id: string }>();

  // Email needs the binding and an origin for its links; without either,
  // skip it (logged) rather than fail webhook delivery too.
  const baseUrl = publicBaseUrl(env);
  const emailReady = emailAlertsAvailable(env) && baseUrl !== null;
  if (emailAlertsAvailable(env) && !baseUrl) console.error("Email alerts skipped: PUBLIC_BASE_URL is not set");
  const emails = emailReady
    ? await env.DB.prepare(
        `SELECT id, user_id, email, unsubscribe_token FROM notification_emails
         WHERE verified_at IS NOT NULL AND user_id IN (${placeholders})`
      )
        .bind(...userIds)
        .all<EmailRecipientRow & { user_id: string }>()
    : { results: [] as (EmailRecipientRow & { user_id: string })[] };

  const results = await Promise.allSettled([
    ...hooks.results.map(async (hook) => (await deliverWebhook(env, hook, alertsByUser.get(hook.user_id)!, now)).ok),
    ...emails.results.map(
      async (r) => (await deliverAlertEmail(env, r, alertsByUser.get(r.user_id)!, now, baseUrl!)) === null
    ),
  ]);
  const failed = results.filter((r) => r.status === "rejected" || !r.value).length;
  const alertCount = [...alertsByUser.values()].reduce((n, list) => n + list.length, 0);
  console.log(
    `Device health check: ${alertCount} alert(s) for ${alertsByUser.size} owner(s), ` +
      `${hooks.results.length} webhook(s) + ${emails.results.length} email(s), ${failed} failed`
  );
}
