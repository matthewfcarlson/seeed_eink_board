import type { Env } from "../types";
import {
  LOW_BATTERY_RECOVER_VOLTAGE,
  LOW_BATTERY_VOLTAGE,
  OFFLINE_AFTER_SECONDS,
  isFleetOutage,
  planDeviceAlerts,
  type DeviceAlert,
  type DeviceHealthInput,
} from "./device-health";
import { sendWebhook, webhookResultStatement, type WebhookRow } from "./notify";
import {
  emailAlertsAvailable,
  emailResultStatement,
  publicBaseUrl,
  sendAlertEmail,
  type EmailRecipientRow,
} from "./email-alerts";

/**
 * Most devices whose alert state can change in one run. The rest stay in the
 * candidate set (their state isn't written) and are picked up next hour.
 * Bounds one invocation's work — Workers allow 1,000 D1 queries and 10,000
 * subrequests per invocation — even if thousands of frames change state at
 * once and the outage guard doesn't catch it.
 */
export const MAX_DEVICES_PER_RUN = 200;

/** Devices the check covers at all. */
const ELIGIBLE = "user_id IS NOT NULL AND secret IS NOT NULL AND last_seen_at IS NOT NULL AND alerts_muted = 0";

interface DeviceRow {
  mac: string;
  user_id: string;
  label: string | null;
  last_seen_at: number;
  last_battery_voltage: number | null;
  offline_alerted_at: number | null;
  low_battery_alerted_at: number | null;
  next_reminder_at: number | null;
}

export function toHealthInput(row: DeviceRow): DeviceHealthInput {
  return {
    mac: row.mac,
    label: row.label,
    lastSeenAt: row.last_seen_at,
    batteryVoltage: row.last_battery_voltage,
    offlineAlertedAt: row.offline_alerted_at,
    lowBatteryAlertedAt: row.low_battery_alerted_at,
    nextReminderAt: row.next_reminder_at,
  };
}

/** One aggregate over the eligible fleet: how many devices were seen in the
 *  last two days, and how many of those crossed the 24h offline line within
 *  the last day without being alerted yet. See isFleetOutage. */
export async function detectFleetOutage(env: Env, now: number): Promise<{ outage: boolean; recentlyActive: number; justOffline: number }> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(last_seen_at >= ?1), 0) AS recently_active,
            COALESCE(SUM(last_seen_at >= ?1 AND last_seen_at < ?2 AND offline_alerted_at IS NULL), 0) AS just_offline
     FROM devices WHERE ${ELIGIBLE}`
  )
    .bind(now - 2 * OFFLINE_AFTER_SECONDS, now - OFFLINE_AFTER_SECONDS)
    .first<{ recently_active: number; just_offline: number }>();
  const recentlyActive = row?.recently_active ?? 0;
  const justOffline = row?.just_offline ?? 0;
  return { outage: isFleetOutage(recentlyActive, justOffline), recentlyActive, justOffline };
}

/**
 * Only the devices that have something to send this run — the SQL form of
 * device-health.ts's planDeviceAlerts conditions (keep them in sync; the
 * health-check unit test checks one against the other). On a normal hour
 * this is a handful of rows, not the whole fleet.
 *
 * `suppressNewOfflineSince`: during a fleet outage, first-time offline
 * alerts for devices last seen at/after this are withheld — and those
 * devices are left out here entirely (unless their battery state changed),
 * so they can't use up MAX_DEVICES_PER_RUN while they wait.
 */
export async function selectAlertCandidates(
  env: Env,
  now: number,
  opts: { suppressNewOfflineSince?: number | null; limit?: number } = {}
): Promise<DeviceRow[]> {
  const cutoff = now - OFFLINE_AFTER_SECONDS;
  const suppressSince = opts.suppressNewOfflineSince ?? null;
  const rows = await env.DB.prepare(
    `SELECT mac, user_id, label, last_seen_at, last_battery_voltage,
            offline_alerted_at, low_battery_alerted_at, next_reminder_at
     FROM devices
     WHERE ${ELIGIBLE} AND (
       -- went offline, not alerted yet (and not held back by the outage guard)
       (last_seen_at < ?1 AND offline_alerted_at IS NULL AND NOT (?5 IS NOT NULL AND last_seen_at >= ?5))
       -- still offline, reminder due
       OR (last_seen_at < ?1 AND offline_alerted_at IS NOT NULL AND (next_reminder_at IS NULL OR next_reminder_at <= ?2))
       -- back online after an alert
       OR (last_seen_at >= ?1 AND offline_alerted_at IS NOT NULL)
       -- battery went low
       OR (low_battery_alerted_at IS NULL AND last_battery_voltage > 0 AND last_battery_voltage < ?3)
       -- battery recovered (no usable reading also clears it, like evaluateDeviceHealth)
       OR (low_battery_alerted_at IS NOT NULL AND NOT (COALESCE(last_battery_voltage, 0) > 0 AND last_battery_voltage < ?4))
     )
     ORDER BY last_seen_at DESC
     LIMIT ?6`
  )
    .bind(cutoff, now, LOW_BATTERY_VOLTAGE, LOW_BATTERY_RECOVER_VOLTAGE, suppressSince, opts.limit ?? MAX_DEVICES_PER_RUN)
    .all<DeviceRow>();
  return rows.results;
}

export interface HealthCheckSummary {
  outage: boolean;
  candidates: number;
  alerts: number;
  owners: number;
  deliveries: number;
  failed: number;
  /** The candidate query hit MAX_DEVICES_PER_RUN — more remain for next run. */
  capped: boolean;
}

/**
 * Hourly (index.ts's scheduled()). Per run: one aggregate query (outage
 * guard), one candidate query, one batched state write, one webhook + one
 * email lookup, the sends, and one batched write of delivery results — a
 * fixed number of D1 calls however large the fleet, and no KV at all.
 *
 * State is written *before* delivery and regardless of its outcome: a broken
 * webhook URL shows up as last_error in /admin rather than re-sending the
 * same alert every hour forever. The tradeoff is that an alert whose
 * delivery failed isn't retried — the next reminder or recovery still is.
 */
export async function runDeviceHealthCheck(env: Env, now = Math.floor(Date.now() / 1000)): Promise<HealthCheckSummary> {
  const fleet = await detectFleetOutage(env, now);
  const suppressNewOfflineSince = fleet.outage ? now - 2 * OFFLINE_AFTER_SECONDS : null;
  if (fleet.outage) {
    console.error(
      `Device health check: ${fleet.justOffline} of ${fleet.recentlyActive} recently active devices went silent ` +
        `in the last day — treating it as a service outage and holding their offline alerts`
    );
  }

  const rows = await selectAlertCandidates(env, now, { suppressNewOfflineSince });
  const summary: HealthCheckSummary = {
    outage: fleet.outage,
    candidates: rows.length,
    alerts: 0,
    owners: 0,
    deliveries: 0,
    failed: 0,
    capped: rows.length >= MAX_DEVICES_PER_RUN,
  };

  const alertsByUser = new Map<string, DeviceAlert[]>();
  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    const plan = planDeviceAlerts(toHealthInput(row), now, { suppressNewOfflineSince });
    if (plan.alerts.length === 0) {
      // The SQL matched but the plan didn't — they've drifted apart.
      console.error(`Device health check: candidate ${row.mac} produced no alert`);
      continue;
    }
    updates.push(
      env.DB.prepare(
        "UPDATE devices SET offline_alerted_at = ?, low_battery_alerted_at = ?, next_reminder_at = ? WHERE mac = ?"
      ).bind(plan.offlineAlertedAt, plan.lowBatteryAlertedAt, plan.nextReminderAt, row.mac)
    );
    const list = alertsByUser.get(row.user_id) ?? [];
    list.push(...plan.alerts);
    alertsByUser.set(row.user_id, list);
    summary.alerts += plan.alerts.length;
  }
  summary.owners = alertsByUser.size;
  if (alertsByUser.size === 0) return summary;
  await env.DB.batch(updates);

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

  const outcomes = await Promise.all([
    ...hooks.results.map(async (hook) => {
      const result = await sendWebhook(hook, alertsByUser.get(hook.user_id)!, now);
      return { ok: result.ok, record: webhookResultStatement(env, hook.id, now, result) };
    }),
    ...emails.results.map(async (r) => {
      const error = await sendAlertEmail(env, r, alertsByUser.get(r.user_id)!, now, baseUrl!);
      return { ok: error === null, record: emailResultStatement(env, r.id, now, error) };
    }),
  ]);
  summary.deliveries = outcomes.length;
  summary.failed = outcomes.filter((o) => !o.ok).length;
  if (outcomes.length > 0) {
    await env.DB.batch(outcomes.map((o) => o.record)).catch((err) =>
      console.error("Failed to record delivery results:", err)
    );
  }

  console.log(
    `Device health check: ${summary.alerts} alert(s) for ${summary.owners} owner(s), ` +
      `${hooks.results.length} webhook(s) + ${emails.results.length} email(s), ${summary.failed} failed` +
      (summary.capped ? ` — hit the ${MAX_DEVICES_PER_RUN}-device cap, more next run` : "")
  );
  return summary;
}
