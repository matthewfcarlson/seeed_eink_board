import type { Env } from "../types";
import { evaluateDeviceHealth, planDeviceAlerts, type DeviceAlert } from "./device-health";
import { kvKeys } from "./kv-keys";
import { deliverWebhook, type WebhookRow } from "./notify";

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
 * persist alert-state transitions, then POST one batched message per owner to
 * each of their webhooks.
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
  const hooks = await env.DB.prepare(
    `SELECT id, user_id, url, format, signing_secret FROM notification_webhooks
     WHERE user_id IN (${userIds.map(() => "?").join(",")})`
  )
    .bind(...userIds)
    .all<WebhookRow & { user_id: string }>();

  const results = await Promise.allSettled(
    hooks.results.map((hook) => deliverWebhook(env, hook, alertsByUser.get(hook.user_id)!, now))
  );
  const failed = results.filter((r) => r.status === "rejected" || !r.value.ok).length;
  const alertCount = [...alertsByUser.values()].reduce((n, list) => n + list.length, 0);
  console.log(
    `Device health check: ${alertCount} alert(s) for ${alertsByUser.size} owner(s), ${hooks.results.length} webhook(s), ${failed} failed`
  );
}
