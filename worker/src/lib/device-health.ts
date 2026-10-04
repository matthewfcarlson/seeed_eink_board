/**
 * Device health detection for owner alerts (see migrations/0025_device_alerts.sql).
 * Pure functions only — lib/health-check.ts (run hourly from index.ts's
 * scheduled()) does the D1 reads and writes, and lib/notify.ts does delivery.
 */

/**
 * A dead frame can't report that it's dead, so "offline" is inferred from
 * silence: no authenticated request for a day. Firmware never deliberately
 * sleeps longer than 24h (device_app.h's calculateSleepSeconds caps at
 * max(refresh interval ≤ 1440 min, time until the next active-window start)),
 * so any schedule wakes at least daily. Edge: a device on a full 1440-minute
 * interval sleeps right up to this line and can alert (then recover) if a
 * wake runs a few minutes long.
 */
export const OFFLINE_AFTER_SECONDS = 24 * 3600;

/**
 * Follow-up pacing while a device stays offline (devices.next_reminder_at —
 * see migrations/0027_offline_reminder_schedule.sql): weekly for its first
 * month offline, then roughly monthly, until it recovers or is muted.
 */
export const WEEKLY_REMINDER_SECONDS = 7 * 86400;
export const MONTHLY_REMINDER_AFTER_SECONDS = 30 * 86400;
export const MONTHLY_REMINDER_SECONDS = 30 * 86400;

/** Below this, alert: roughly the last ~10% of a LiPo's usable range on this
 *  board's divider (see CLAUDE.md's battery notes: 3.0V empty, 4.2V full; the
 *  admin UI's battery pill treats 3.2V as 0%). */
export const LOW_BATTERY_VOLTAGE = 3.5;
/** Hysteresis: once alerted, only call it recovered at/above this, so a
 *  reading wobbling around 3.5V doesn't flap low/ok every hour. Plugging in
 *  USB reads >4.2V, comfortably above. */
export const LOW_BATTERY_RECOVER_VOLTAGE = 3.7;

export interface DeviceHealthInput {
  mac: string;
  label: string | null;
  lastSeenAt: number | null;
  batteryVoltage: number | null;
  offlineAlertedAt: number | null;
  lowBatteryAlertedAt: number | null;
  /** When the next "still_offline" reminder is due (only meaningful while
   *  offlineAlertedAt is set; evaluateDeviceHealth ignores it). */
  nextReminderAt?: number | null;
}

export interface DeviceHealth {
  offline: boolean;
  lowBattery: boolean;
  /** null when the device has never checked in (nothing to be overdue against). */
  offlineAfter: number | null;
}

export function evaluateDeviceHealth(d: DeviceHealthInput, now: number): DeviceHealth {
  const offlineAfter = d.lastSeenAt != null ? d.lastSeenAt + OFFLINE_AFTER_SECONDS : null;
  const v = d.batteryVoltage;
  // Hysteresis: the threshold that applies depends on whether we're already
  // in the alerted state.
  const lowBattery =
    v != null && v > 0 && (d.lowBatteryAlertedAt != null ? v < LOW_BATTERY_RECOVER_VOLTAGE : v < LOW_BATTERY_VOLTAGE);
  return { offline: offlineAfter != null && now > offlineAfter, lowBattery, offlineAfter };
}

/** How long until the next "still offline" reminder, given how long the
 *  device has been silent as of this one. */
export function reminderIntervalSeconds(lastSeenAt: number, now: number): number {
  return now - lastSeenAt < MONTHLY_REMINDER_AFTER_SECONDS ? WEEKLY_REMINDER_SECONDS : MONTHLY_REMINDER_SECONDS;
}

export type AlertKind = "offline" | "still_offline" | "back_online" | "low_battery" | "battery_ok";

export interface DeviceAlert {
  kind: AlertKind;
  mac: string;
  label: string | null;
  lastSeenAt: number | null;
  batteryVoltage: number | null;
}

export interface DeviceAlertPlan {
  alerts: DeviceAlert[];
  /** New alert-state columns to persist (unchanged values when nothing fired). */
  offlineAlertedAt: number | null;
  lowBatteryAlertedAt: number | null;
  nextReminderAt: number | null;
}

export interface PlanOptions {
  /**
   * Fleet-outage guard (see isFleetOutage): withhold the first "offline"
   * alert for devices last seen at/after this epoch — the ones that just
   * crossed the 24h line together. They stay un-alerted, so they're
   * reconsidered next run; once they fall out of the window (another day of
   * silence) they alert normally, and if they come back nothing was sent.
   */
  suppressNewOfflineSince?: number | null;
}

/**
 * State transitions for one device. Alerts fire when health differs from
 * what was last alerted, plus a "still_offline" follow-up whenever
 * `nextReminderAt` has passed (weekly for the first 30 days offline, then
 * monthly — see reminderIntervalSeconds). A NULL nextReminderAt on an
 * alerted device counts as due.
 *
 * lib/health-check.ts's candidate query mirrors these conditions in SQL so
 * only devices with something to do are loaded — keep the two in sync
 * (test/unit/health-check.test.ts checks them against each other).
 */
export function planDeviceAlerts(d: DeviceHealthInput, now: number, opts: PlanOptions = {}): DeviceAlertPlan {
  const health = evaluateDeviceHealth(d, now);
  const alerts: DeviceAlert[] = [];
  const base = { mac: d.mac, label: d.label, lastSeenAt: d.lastSeenAt, batteryVoltage: d.batteryVoltage };
  let offlineAlertedAt = d.offlineAlertedAt;
  let lowBatteryAlertedAt = d.lowBatteryAlertedAt;
  let nextReminderAt = d.nextReminderAt ?? null;

  if (health.offline) {
    const suppressed =
      offlineAlertedAt == null && opts.suppressNewOfflineSince != null && d.lastSeenAt! >= opts.suppressNewOfflineSince;
    const reminderDue = offlineAlertedAt != null && (nextReminderAt == null || nextReminderAt <= now);
    if ((offlineAlertedAt == null && !suppressed) || reminderDue) {
      alerts.push({ kind: offlineAlertedAt == null ? "offline" : "still_offline", ...base });
      offlineAlertedAt ??= now;
      nextReminderAt = now + reminderIntervalSeconds(d.lastSeenAt!, now);
    }
  } else if (offlineAlertedAt != null) {
    alerts.push({ kind: "back_online", ...base });
    offlineAlertedAt = null;
    nextReminderAt = null;
  }

  if (health.lowBattery && lowBatteryAlertedAt == null) {
    alerts.push({ kind: "low_battery", ...base });
    lowBatteryAlertedAt = now;
  } else if (!health.lowBattery && lowBatteryAlertedAt != null) {
    alerts.push({ kind: "battery_ok", ...base });
    lowBatteryAlertedAt = null;
  }

  return { alerts, offlineAlertedAt, lowBatteryAlertedAt, nextReminderAt };
}

/** A spike only counts as an outage at this size — a household's 3 frames
 *  losing the same WiFi is a real alert, not our outage. */
export const OUTAGE_MIN_DEVICES = 20;
/** ...and when at least this share of recently active devices went silent
 *  in the same day. A handful of frames dying daily stays far below it. */
export const OUTAGE_FRACTION = 0.2;

/**
 * Whether this run looks like *our* outage (a bad deploy, a firmware bug,
 * a Cloudflare incident) rather than many owners' frames independently
 * dying: `justOffline` devices crossed the 24h line within the last day, out
 * of `recentlyActive` seen within the last two days (which includes them).
 */
export function isFleetOutage(recentlyActive: number, justOffline: number): boolean {
  return justOffline >= OUTAGE_MIN_DEVICES && justOffline >= OUTAGE_FRACTION * recentlyActive;
}
