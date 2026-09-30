/**
 * Device health detection for owner alerts (see migrations/0024_device_alerts.sql).
 * Pure functions only — lib/health-check.ts (run hourly from index.ts's
 * scheduled()) does the D1/KV reads and writes, and lib/notify.ts does delivery.
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
 * Follow-up pacing while a device stays offline (paced by a KV key's TTL —
 * see health-check.ts): weekly for its first month offline, then roughly
 * monthly, until it recovers or its owner mutes it.
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
  /** Arm the reminder key with this TTL (seconds), or null to leave it alone. */
  armReminderSeconds: number | null;
  /** Delete the reminder key (device recovered). */
  clearReminder: boolean;
}

/**
 * State transitions for one device. `reminderDue` is whether this device's
 * reminder key has expired from KV — only consulted while it's already
 * alerted as offline. Alerts fire when health differs from what was last
 * alerted, plus a "still_offline" follow-up each time the reminder lapses.
 */
export function planDeviceAlerts(d: DeviceHealthInput, now: number, reminderDue = false): DeviceAlertPlan {
  const health = evaluateDeviceHealth(d, now);
  const alerts: DeviceAlert[] = [];
  const base = { mac: d.mac, label: d.label, lastSeenAt: d.lastSeenAt, batteryVoltage: d.batteryVoltage };
  let offlineAlertedAt = d.offlineAlertedAt;
  let lowBatteryAlertedAt = d.lowBatteryAlertedAt;
  let armReminderSeconds: number | null = null;
  let clearReminder = false;

  if (health.offline) {
    if (offlineAlertedAt == null || reminderDue) {
      alerts.push({ kind: offlineAlertedAt == null ? "offline" : "still_offline", ...base });
      offlineAlertedAt ??= now;
      armReminderSeconds = reminderIntervalSeconds(d.lastSeenAt!, now);
    }
  } else if (offlineAlertedAt != null) {
    alerts.push({ kind: "back_online", ...base });
    offlineAlertedAt = null;
    clearReminder = true;
  }

  if (health.lowBattery && lowBatteryAlertedAt == null) {
    alerts.push({ kind: "low_battery", ...base });
    lowBatteryAlertedAt = now;
  } else if (!health.lowBattery && lowBatteryAlertedAt != null) {
    alerts.push({ kind: "battery_ok", ...base });
    lowBatteryAlertedAt = null;
  }

  return { alerts, offlineAlertedAt, lowBatteryAlertedAt, armReminderSeconds, clearReminder };
}
