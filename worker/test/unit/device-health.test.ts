import { describe, expect, it } from "vitest";
import {
  LOW_BATTERY_RECOVER_VOLTAGE,
  LOW_BATTERY_VOLTAGE,
  MONTHLY_REMINDER_SECONDS,
  OFFLINE_AFTER_SECONDS,
  WEEKLY_REMINDER_SECONDS,
  evaluateDeviceHealth,
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

  it("alerts once when a device goes offline and arms a weekly reminder", () => {
    const plan = planDeviceAlerts(device(), late);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["offline"]);
    expect(plan.offlineAlertedAt).toBe(late);
    expect(plan.armReminderSeconds).toBe(WEEKLY_REMINDER_SECONDS);
  });

  it("stays quiet while the reminder key is still live", () => {
    const plan = planDeviceAlerts(device({ offlineAlertedAt: late }), late + 3 * DAY, false);
    expect(plan.alerts).toEqual([]);
    expect(plan.armReminderSeconds).toBeNull();
    expect(plan.offlineAlertedAt).toBe(late);
  });

  it("sends a still_offline reminder once the key expires, keeping the original alert time", () => {
    const plan = planDeviceAlerts(device({ offlineAlertedAt: late }), late + 7 * DAY, true);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["still_offline"]);
    expect(plan.offlineAlertedAt).toBe(late);
    expect(plan.armReminderSeconds).toBe(WEEKLY_REMINDER_SECONDS);
  });

  it("switches to monthly reminders after 30 days offline", () => {
    const plan = planDeviceAlerts(device({ offlineAlertedAt: late }), T0 + 36 * DAY, true);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["still_offline"]);
    expect(plan.armReminderSeconds).toBe(MONTHLY_REMINDER_SECONDS);
  });

  it("sends a recovery alert and clears the reminder when the device checks in again", () => {
    const plan = planDeviceAlerts(device({ lastSeenAt: late, offlineAlertedAt: late - H }), late + 60, true);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["back_online"]);
    expect(plan.offlineAlertedAt).toBeNull();
    expect(plan.clearReminder).toBe(true);
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

  it("is a no-op for a healthy device", () => {
    expect(planDeviceAlerts(device(), T0 + H)).toEqual({
      alerts: [],
      offlineAlertedAt: null,
      lowBatteryAlertedAt: null,
      armReminderSeconds: null,
      clearReminder: false,
    });
  });
});
