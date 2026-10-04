import { describe, expect, it } from "vitest";
import {
  LOW_BATTERY_RECOVER_VOLTAGE,
  LOW_BATTERY_VOLTAGE,
  MONTHLY_REMINDER_SECONDS,
  OFFLINE_AFTER_SECONDS,
  WEEKLY_REMINDER_SECONDS,
  evaluateDeviceHealth,
  isFleetOutage,
  planDeviceAlerts,
  reminderIntervalSeconds,
  type DeviceHealthInput,
} from "../../src/lib/device-health";

const T0 = Date.UTC(2026, 0, 1) / 1000;
const H = 3600;
const DAY = 86400;

function device(overrides: Partial<DeviceHealthInput> = {}): DeviceHealthInput {
  return {
    mac: "aabbccddeeff",
    label: "Kitchen",
    lastSeenAt: T0,
    batteryVoltage: 3.9,
    offlineAlertedAt: null,
    lowBatteryAlertedAt: null,
    nextReminderAt: null,
    ...overrides,
  };
}

describe("evaluateDeviceHealth offline", () => {
  it("is offline only after 24h of silence", () => {
    expect(evaluateDeviceHealth(device(), T0 + OFFLINE_AFTER_SECONDS).offline).toBe(false);
    expect(evaluateDeviceHealth(device(), T0 + OFFLINE_AFTER_SECONDS + 1).offline).toBe(true);
    expect(evaluateDeviceHealth(device(), T0).offlineAfter).toBe(T0 + 24 * H);
  });

  it("never flags a device that has never checked in", () => {
    expect(evaluateDeviceHealth(device({ lastSeenAt: null }), T0 + 100 * DAY)).toMatchObject({
      offline: false,
      offlineAfter: null,
    });
  });
});

describe("evaluateDeviceHealth battery", () => {
  it("flags low battery below the threshold", () => {
    expect(evaluateDeviceHealth(device({ batteryVoltage: LOW_BATTERY_VOLTAGE - 0.01 }), T0).lowBattery).toBe(true);
    expect(evaluateDeviceHealth(device({ batteryVoltage: LOW_BATTERY_VOLTAGE }), T0).lowBattery).toBe(false);
  });

  it("keeps an alerted device low until it clears the recovery threshold (hysteresis)", () => {
    const alerted = { lowBatteryAlertedAt: T0 };
    expect(evaluateDeviceHealth(device({ ...alerted, batteryVoltage: 3.6 }), T0).lowBattery).toBe(true);
    expect(evaluateDeviceHealth(device({ ...alerted, batteryVoltage: LOW_BATTERY_RECOVER_VOLTAGE }), T0).lowBattery).toBe(false);
  });

  it("ignores a missing reading", () => {
    expect(evaluateDeviceHealth(device({ batteryVoltage: null }), T0).lowBattery).toBe(false);
  });
});

describe("reminderIntervalSeconds", () => {
  it("is weekly for the first 30 days offline, then monthly", () => {
    expect(reminderIntervalSeconds(T0, T0 + 1 * DAY)).toBe(WEEKLY_REMINDER_SECONDS);
    expect(reminderIntervalSeconds(T0, T0 + 29 * DAY)).toBe(WEEKLY_REMINDER_SECONDS);
    expect(reminderIntervalSeconds(T0, T0 + 30 * DAY)).toBe(MONTHLY_REMINDER_SECONDS);
  });
});

describe("planDeviceAlerts", () => {
  const late = T0 + 25 * H;

  it("alerts once when a device goes offline and schedules a weekly reminder", () => {
    const plan = planDeviceAlerts(device(), late);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["offline"]);
    expect(plan.offlineAlertedAt).toBe(late);
    expect(plan.nextReminderAt).toBe(late + WEEKLY_REMINDER_SECONDS);
  });

  it("stays quiet until the reminder is due", () => {
    const plan = planDeviceAlerts(device({ offlineAlertedAt: late, nextReminderAt: late + 7 * DAY }), late + 3 * DAY);
    expect(plan.alerts).toEqual([]);
    expect(plan.nextReminderAt).toBe(late + 7 * DAY);
    expect(plan.offlineAlertedAt).toBe(late);
  });

  it("sends a still_offline reminder once due, keeping the original alert time", () => {
    const now = late + 7 * DAY;
    const plan = planDeviceAlerts(device({ offlineAlertedAt: late, nextReminderAt: now }), now);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["still_offline"]);
    expect(plan.offlineAlertedAt).toBe(late);
    expect(plan.nextReminderAt).toBe(now + WEEKLY_REMINDER_SECONDS);
  });

  it("treats a missing reminder time on an alerted device as due", () => {
    const plan = planDeviceAlerts(device({ offlineAlertedAt: late, nextReminderAt: null }), late + H);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["still_offline"]);
  });

  it("switches to monthly reminders after 30 days offline", () => {
    const now = T0 + 36 * DAY;
    const plan = planDeviceAlerts(device({ offlineAlertedAt: late, nextReminderAt: now - H }), now);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["still_offline"]);
    expect(plan.nextReminderAt).toBe(now + MONTHLY_REMINDER_SECONDS);
  });

  it("sends a recovery alert and clears the reminder when the device checks in again", () => {
    const plan = planDeviceAlerts(device({ lastSeenAt: late, offlineAlertedAt: late - H, nextReminderAt: late + DAY }), late + 60);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["back_online"]);
    expect(plan.offlineAlertedAt).toBeNull();
    expect(plan.nextReminderAt).toBeNull();
  });

  it("handles battery transitions independently of connectivity", () => {
    expect(planDeviceAlerts(device({ batteryVoltage: 3.4 }), late).alerts.map((a) => a.kind)).toEqual([
      "offline",
      "low_battery",
    ]);
    const charged = planDeviceAlerts(device({ lastSeenAt: late, batteryVoltage: 4.25, lowBatteryAlertedAt: late - H }), late + 60);
    expect(charged.alerts.map((a) => a.kind)).toEqual(["battery_ok"]);
    expect(charged.lowBatteryAlertedAt).toBeNull();
  });

  it("withholds a first offline alert during a fleet outage, but not reminders or battery alerts", () => {
    const opts = { suppressNewOfflineSince: late - 2 * DAY };
    expect(planDeviceAlerts(device(), late, opts).alerts).toEqual([]);
    expect(planDeviceAlerts(device(), late, opts).offlineAlertedAt).toBeNull();
    expect(planDeviceAlerts(device({ batteryVoltage: 3.4 }), late, opts).alerts.map((a) => a.kind)).toEqual(["low_battery"]);
    expect(
      planDeviceAlerts(device({ offlineAlertedAt: late - DAY, nextReminderAt: late }), late, opts).alerts.map((a) => a.kind)
    ).toEqual(["still_offline"]);
    // Silent since before the window: not part of this spike, alerts normally.
    expect(planDeviceAlerts(device({ lastSeenAt: late - 3 * DAY }), late, opts).alerts.map((a) => a.kind)).toEqual([
      "offline",
    ]);
  });

  it("is a no-op for a healthy device", () => {
    expect(planDeviceAlerts(device(), T0 + H)).toEqual({
      alerts: [],
      offlineAlertedAt: null,
      lowBatteryAlertedAt: null,
      nextReminderAt: null,
    });
  });
});

describe("isFleetOutage", () => {
  it("needs both a minimum count and a large share of recently active devices", () => {
    expect(isFleetOutage(6000, 60)).toBe(false); // 1% — ordinary daily churn
    expect(isFleetOutage(6000, 1500)).toBe(true); // 25%
    expect(isFleetOutage(10, 10)).toBe(false); // one household's WiFi — below the minimum
    expect(isFleetOutage(80, 20)).toBe(true);
    expect(isFleetOutage(200, 20)).toBe(false);
  });
});
