import type { Env } from "../types";
import { planDeviceAlerts, type DeviceAlert } from "./device-health";
import { deliverWebhook, type WebhookRow } from "./notify";

interface DeviceRow {
  mac: string;
  user_id: string;
  label: string | null;
  last_seen_at: number | null;
  last_battery_voltage: number | null;
  offline_alerted_at: number | null;
  low_battery_alerted_at: number | null;
  refresh_interval_minutes: number | null;
  active_start_hour: number | null;
  active_end_hour: number | null;
  timezone_offset_minutes: number | null;
}

/**
 * Hourly (index.ts's scheduled()): evaluate every registered, un-muted device,
 * persist alert-state transitions, then POST one batched message per owner to
 * each of their webhooks.
 *
 * State is written *before* delivery and regardless of its outcome: a broken
 * webhook URL shows up as last_error in /admin rather than re-sending the same
 * alert every hour forever. The tradeoff is that an alert whose delivery
 * failed isn't retried — the next transition (recovery) is still sent.
 */
export async function runDeviceHealthCheck(env: Env, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT d.mac, d.user_id, d.label, d.last_seen_at, d.last_battery_voltage,
            d.offline_alerted_at, d.low_battery_alerted_at,
            s.refresh_interval_minutes, s.active_start_hour, s.active_end_hour, s.timezone_offset_minutes
     FROM devices d
     LEFT JOIN schedule_overrides s ON s.target = d.mac
     WHERE d.user_id IS NOT NULL AND d.secret IS NOT NULL
       AND d.last_seen_at IS NOT NULL AND d.alerts_muted = 0`
  ).all<DeviceRow>();

  const alertsByUser = new Map<string, DeviceAlert[]>();
  const updates: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const plan = planDeviceAlerts(
      {
        mac: row.mac,
        label: row.label,
        lastSeenAt: row.last_seen_at,
        batteryVoltage: row.last_battery_voltage,
        offlineAlertedAt: row.offline_alerted_at,
        lowBatteryAlertedAt: row.low_battery_alerted_at,
        schedule: {
          refresh_interval_minutes: row.refresh_interval_minutes ?? undefined,
          active_start_hour: row.active_start_hour ?? undefined,
          active_end_hour: row.active_end_hour ?? undefined,
          timezone_offset_minutes: row.timezone_offset_minutes ?? undefined,
        },
      },
      now
    );
    if (plan.alerts.length === 0) continue;
    updates.push(
      env.DB.prepare("UPDATE devices SET offline_alerted_at = ?, low_battery_alerted_at = ? WHERE mac = ?").bind(
        plan.offlineAlertedAt,
        plan.lowBatteryAlertedAt,
        row.mac
      )
    );
    const list = alertsByUser.get(row.user_id) ?? [];
    list.push(...plan.alerts);
    alertsByUser.set(row.user_id, list);
  }

  if (updates.length === 0) return;
  await env.DB.batch(updates);

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
  console.log(
    `Device health check: ${updates.length} device(s) changed state, ${hooks.results.length} webhook(s), ${failed} failed`
  );
}
