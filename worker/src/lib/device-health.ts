import type { ScheduleConfig } from "../types";

/**
 * Device health detection for owner alerts (see migrations/0024_device_alerts.sql).
 * Pure functions only — index.ts's scheduled() → runDeviceHealthCheck() does
 * the D1 reads/writes and lib/notify.ts does delivery.
 *
 * A dead frame can't report that it's dead, so "offline" is inferred: work out
 * when the device *should* next have woken (the same sleep math the firmware
 * runs — device_app.h's calculateSleepSeconds), and flag it once that's
 * passed by a grace margin.
 */

/** Below this, alert: roughly the last ~10% of a LiPo's usable range on this
 *  board's divider (see CLAUDE.md's battery notes: 3.0V empty, 4.2V full; the
 *  admin UI's battery pill treats 3.2V as 0%). */
export const LOW_BATTERY_VOLTAGE = 3.5;
/** Hysteresis: once alerted, only call it recovered at/above this, so a
 *  reading wobbling around 3.5V doesn't flap low/ok every hour. Plugging in
 *  USB reads >4.2V, comfortably above. */
export const LOW_BATTERY_RECOVER_VOLTAGE = 3.7;

/** Minimum slack past the expected wake before calling a device offline —
 *  covers WiFi association, a slow download, and the cron's own jitter for
 *  devices on very short refresh intervals. */
const MIN_GRACE_SECONDS = 30 * 60;

/**
 * Without a server-side schedule override the device runs whatever it was
 * provisioned with over BLE (interval, active hours, timezone) — none of
 * which it reports back. But calculateSleepSeconds never sleeps longer than
 * max(refresh interval ≤ 1440 min, time until the next active-window start
 * < 24h), so no healthy device is ever silent for more than a day. Past that
 * (plus an hour of slack) it's overdue whatever its schedule is.
 */
export const UNKNOWN_SCHEDULE_OFFLINE_AFTER_SECONDS = 25 * 3600;

// Mirrors firmware MIN_SLEEP_SECONDS floor closely enough for alerting; the
// grace margin dwarfs it anyway.
const MIN_SLEEP_SECONDS = 60;

interface FullSchedule {
  refreshMinutes: number;
  activeStartHour: number;
  activeEndHour: number;
  timezoneOffsetMinutes: number;
}

function fullSchedule(config: ScheduleConfig | null): FullSchedule | null {
  if (
    !config ||
    config.refresh_interval_minutes == null ||
    config.active_start_hour == null ||
    config.active_end_hour == null ||
    config.timezone_offset_minutes == null
  ) {
    return null;
  }
  return {
    refreshMinutes: config.refresh_interval_minutes,
    activeStartHour: config.active_start_hour,
    activeEndHour: config.active_end_hour,
    timezoneOffsetMinutes: config.timezone_offset_minutes,
  };
}

function localSecondsOfDay(utc: number, tzMinutes: number): number {
  const s = (utc + tzMinutes * 60) % 86400;
  return s < 0 ? s + 86400 : s;
}

function isWithinActiveWindow(utc: number, start: number, end: number, tz: number): boolean {
  if (start === end) return true;
  const sod = localSecondsOfDay(utc, tz);
  const startS = start * 3600;
  const endS = end * 3600;
  return start < end ? sod >= startS && sod < endS : sod >= startS || sod < endS;
}

function secondsUntilNextActiveWindow(utc: number, start: number, tz: number): number {
  const sod = localSecondsOfDay(utc, tz);
  const startS = start * 3600;
  return sod < startS ? startS - sod : 86400 - sod + startS;
}

function secondsUntilWindowEnd(utc: number, start: number, end: number, tz: number): number {
  if (start === end) return Number.POSITIVE_INFINITY;
  const sod = localSecondsOfDay(utc, tz);
  const startS = start * 3600;
  const endS = end * 3600;
  if (start < end) return endS - sod;
  return sod >= startS ? 86400 - sod + endS : endS - sod;
}

/** TS port of firmware/lib/common/device_app.h's calculateSleepSeconds, for a
 *  device whose clock is valid (any device that completed /device_config). */
export function expectedSleepSeconds(wakeAt: number, s: FullSchedule): number {
  const refresh = s.refreshMinutes * 60;
  const { activeStartHour: start, activeEndHour: end, timezoneOffsetMinutes: tz } = s;
  if (!isWithinActiveWindow(wakeAt, start, end, tz)) {
    return Math.max(secondsUntilNextActiveWindow(wakeAt, start, tz), MIN_SLEEP_SECONDS);
  }
  if (refresh < secondsUntilWindowEnd(wakeAt, start, end, tz)) {
    return Math.max(refresh, MIN_SLEEP_SECONDS);
  }
  return Math.max(secondsUntilNextActiveWindow(wakeAt, start, tz), MIN_SLEEP_SECONDS);
}

/**
 * Epoch after which a device last seen at `lastSeenAt` counts as offline.
 *
 * Known schedule: its next expected wake plus a grace of two refresh
 * intervals (min 30 min), so a single missed wake — one WiFi blip — never
 * alerts. Caveat: an override saved since the device's last wake is used here
 * even though the device computed its current sleep from the old one; a
 * lengthened interval can alert early once. Unknown schedule: see
 * UNKNOWN_SCHEDULE_OFFLINE_AFTER_SECONDS.
 */
export function offlineDeadline(lastSeenAt: number, schedule: ScheduleConfig | null): number {
  const s = fullSchedule(schedule);
  if (!s) return lastSeenAt + UNKNOWN_SCHEDULE_OFFLINE_AFTER_SECONDS;
  const grace = Math.max(2 * s.refreshMinutes * 60, MIN_GRACE_SECONDS);
  return lastSeenAt + expectedSleepSeconds(lastSeenAt, s) + grace;
}

export interface DeviceHealthInput {
  mac: string;
  label: string | null;
  lastSeenAt: number | null;
  batteryVoltage: number | null;
  offlineAlertedAt: number | null;
  lowBatteryAlertedAt: number | null;
  schedule: ScheduleConfig | null;
}

export interface DeviceHealth {
  offline: boolean;
  lowBattery: boolean;
  /** null when the device has never checked in (nothing to be overdue against). */
  offlineAfter: number | null;
}

export function evaluateDeviceHealth(d: DeviceHealthInput, now: number): DeviceHealth {
  const offlineAfter = d.lastSeenAt != null ? offlineDeadline(d.lastSeenAt, d.schedule) : null;
  const v = d.batteryVoltage;
  // Hysteresis: the threshold that applies depends on whether we're already
  // in the alerted state.
  const lowBattery =
    v != null && v > 0 && (d.lowBatteryAlertedAt != null ? v < LOW_BATTERY_RECOVER_VOLTAGE : v < LOW_BATTERY_VOLTAGE);
  return { offline: offlineAfter != null && now > offlineAfter, lowBattery, offlineAfter };
}

export type AlertKind = "offline" | "back_online" | "low_battery" | "battery_ok";

export interface DeviceAlert {
  kind: AlertKind;
  mac: string;
  label: string | null;
  lastSeenAt: number | null;
  batteryVoltage: number | null;
}

/**
 * State transitions for one device: an alert fires only when health differs
 * from what was last alerted. Returns the alerts plus the new alert-state
 * columns to persist (unchanged values when nothing fired).
 */
export function planDeviceAlerts(
  d: DeviceHealthInput,
  now: number
): { alerts: DeviceAlert[]; offlineAlertedAt: number | null; lowBatteryAlertedAt: number | null } {
  const health = evaluateDeviceHealth(d, now);
  const alerts: DeviceAlert[] = [];
  const base = { mac: d.mac, label: d.label, lastSeenAt: d.lastSeenAt, batteryVoltage: d.batteryVoltage };
  let offlineAlertedAt = d.offlineAlertedAt;
  let lowBatteryAlertedAt = d.lowBatteryAlertedAt;

  if (health.offline && offlineAlertedAt == null) {
    alerts.push({ kind: "offline", ...base });
    offlineAlertedAt = now;
  } else if (!health.offline && offlineAlertedAt != null) {
    alerts.push({ kind: "back_online", ...base });
    offlineAlertedAt = null;
  }

  if (health.lowBattery && lowBatteryAlertedAt == null) {
    alerts.push({ kind: "low_battery", ...base });
    lowBatteryAlertedAt = now;
  } else if (!health.lowBattery && lowBatteryAlertedAt != null) {
    alerts.push({ kind: "battery_ok", ...base });
    lowBatteryAlertedAt = null;
  }

  return { alerts, offlineAlertedAt, lowBatteryAlertedAt };
}
