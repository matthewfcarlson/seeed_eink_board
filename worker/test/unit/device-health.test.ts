import { describe, expect, it } from "vitest";
import {
  LOW_BATTERY_RECOVER_VOLTAGE,
  LOW_BATTERY_VOLTAGE,
  UNKNOWN_SCHEDULE_OFFLINE_AFTER_SECONDS,
  evaluateDeviceHealth,
  expectedSleepSeconds,
  offlineDeadline,
  planDeviceAlerts,
  type DeviceHealthInput,
} from "../../src/lib/device-health";

// 2026-01-01T00:00:00Z — a UTC midnight, so hour arithmetic below is readable.
const MIDNIGHT = Date.UTC(2026, 0, 1) / 1000;
const H = 3600;

const hourly8to20Utc = {
  refresh_interval_minutes: 60,
  active_start_hour: 8,
  active_end_hour: 20,
  timezone_offset_minutes: 0,
};

function device(overrides: Partial<DeviceHealthInput> = {}): DeviceHealthInput {
  return {
    mac: "aabbccddeeff",
    label: "Kitchen",
    lastSeenAt: MIDNIGHT + 10 * H,
    batteryVoltage: 3.9,
    offlineAlertedAt: null,
    lowBatteryAlertedAt: null,
    schedule: hourly8to20Utc,
    ...overrides,
  };
}

describe("expectedSleepSeconds (port of firmware calculateSleepSeconds)", () => {
  const s = { refreshMinutes: 60, activeStartHour: 8, activeEndHour: 20, timezoneOffsetMinutes: 0 };

  it("sleeps one refresh interval mid-window", () => {
    expect(expectedSleepSeconds(MIDNIGHT + 10 * H, s)).toBe(H);
  });

  it("sleeps until the next window start when the next refresh would land in quiet hours", () => {
    // 19:30 + 60 min = 20:30, past the window end → sleep to 08:00 next day.
    expect(expectedSleepSeconds(MIDNIGHT + 19.5 * H, s)).toBe(12.5 * H);
  });

  it("sleeps until the window start when woken outside it", () => {
    expect(expectedSleepSeconds(MIDNIGHT + 2 * H, s)).toBe(6 * H);
  });

  it("applies the timezone offset", () => {
    // UTC-6: 14:00 UTC is 08:00 local — inside the window.
    expect(expectedSleepSeconds(MIDNIGHT + 14 * H, { ...s, timezoneOffsetMinutes: -360 })).toBe(H);
    // 03:00 UTC is 21:00 local — outside; next start 08:00 local = 14:00 UTC.
    expect(expectedSleepSeconds(MIDNIGHT + 3 * H, { ...s, timezoneOffsetMinutes: -360 })).toBe(11 * H);
  });

  it("handles a window that wraps midnight", () => {
    const wrap = { ...s, activeStartHour: 22, activeEndHour: 6 };
    expect(expectedSleepSeconds(MIDNIGHT + 23 * H, wrap)).toBe(H);
    expect(expectedSleepSeconds(MIDNIGHT + 12 * H, wrap)).toBe(10 * H);
  });

  it("treats start == end as always active", () => {
    expect(expectedSleepSeconds(MIDNIGHT + 3 * H, { ...s, activeStartHour: 0, activeEndHour: 0 })).toBe(H);
  });
});

describe("offlineDeadline", () => {
  it("adds two refresh intervals of grace to the expected wake", () => {
    expect(offlineDeadline(MIDNIGHT + 10 * H, hourly8to20Utc)).toBe(MIDNIGHT + 10 * H + H + 2 * H);
  });

  it("uses at least 30 minutes of grace for short intervals", () => {
    const fast = { ...hourly8to20Utc, refresh_interval_minutes: 5 };
    expect(offlineDeadline(MIDNIGHT + 10 * H, fast)).toBe(MIDNIGHT + 10 * H + 5 * 60 + 30 * 60);
  });

  it("does not flag a device sleeping through its quiet hours overnight", () => {
    const lastWake = MIDNIGHT + 19.5 * H; // last wake of the day
    const d = device({ lastSeenAt: lastWake });
    expect(evaluateDeviceHealth(d, MIDNIGHT + 30 * H).offline).toBe(false); // 06:00 next day
    expect(evaluateDeviceHealth(d, MIDNIGHT + 34.5 * H).offline).toBe(true); // 10:30 next day, past 08:00 + 2h grace
  });

  it("falls back to a 25h ceiling when the device has no server-side schedule", () => {
    expect(offlineDeadline(MIDNIGHT, null)).toBe(MIDNIGHT + UNKNOWN_SCHEDULE_OFFLINE_AFTER_SECONDS);
    expect(offlineDeadline(MIDNIGHT, {})).toBe(MIDNIGHT + UNKNOWN_SCHEDULE_OFFLINE_AFTER_SECONDS);
  });
});

describe("evaluateDeviceHealth battery", () => {
  it("flags low battery below the threshold", () => {
    expect(evaluateDeviceHealth(device({ batteryVoltage: LOW_BATTERY_VOLTAGE - 0.01 }), MIDNIGHT + 10 * H).lowBattery).toBe(true);
    expect(evaluateDeviceHealth(device({ batteryVoltage: LOW_BATTERY_VOLTAGE }), MIDNIGHT + 10 * H).lowBattery).toBe(false);
  });

  it("keeps an alerted device low until it clears the recovery threshold (hysteresis)", () => {
    const alerted = { lowBatteryAlertedAt: MIDNIGHT };
    expect(evaluateDeviceHealth(device({ ...alerted, batteryVoltage: 3.6 }), MIDNIGHT + 10 * H).lowBattery).toBe(true);
    expect(
      evaluateDeviceHealth(device({ ...alerted, batteryVoltage: LOW_BATTERY_RECOVER_VOLTAGE }), MIDNIGHT + 10 * H).lowBattery
    ).toBe(false);
  });

  it("ignores a missing reading", () => {
    expect(evaluateDeviceHealth(device({ batteryVoltage: null }), MIDNIGHT + 10 * H).lowBattery).toBe(false);
  });

  it("never flags offline for a device that has never checked in", () => {
    const h = evaluateDeviceHealth(device({ lastSeenAt: null }), MIDNIGHT + 100 * H);
    expect(h).toMatchObject({ offline: false, offlineAfter: null });
  });
});

describe("planDeviceAlerts", () => {
  const late = MIDNIGHT + 20 * H; // long after a 10:00 wake on an hourly schedule

  it("alerts once when a device goes offline, then stays quiet", () => {
    const first = planDeviceAlerts(device(), late);
    expect(first.alerts.map((a) => a.kind)).toEqual(["offline"]);
    expect(first.offlineAlertedAt).toBe(late);

    const second = planDeviceAlerts(device({ offlineAlertedAt: first.offlineAlertedAt }), late + H);
    expect(second.alerts).toEqual([]);
    expect(second.offlineAlertedAt).toBe(late);
  });

  it("sends a recovery alert and clears state when the device checks in again", () => {
    const plan = planDeviceAlerts(device({ lastSeenAt: late, offlineAlertedAt: late - H }), late + 60);
    expect(plan.alerts.map((a) => a.kind)).toEqual(["back_online"]);
    expect(plan.offlineAlertedAt).toBeNull();
  });

  it("handles battery transitions independently of connectivity", () => {
    const low = planDeviceAlerts(device({ batteryVoltage: 3.4 }), late);
    expect(low.alerts.map((a) => a.kind)).toEqual(["offline", "low_battery"]);

    const charged = planDeviceAlerts(
      device({ lastSeenAt: late, batteryVoltage: 4.25, lowBatteryAlertedAt: late - H }),
      late + 60
    );
    expect(charged.alerts.map((a) => a.kind)).toEqual(["battery_ok"]);
    expect(charged.lowBatteryAlertedAt).toBeNull();
  });

  it("is a no-op for a healthy device", () => {
    const plan = planDeviceAlerts(device(), MIDNIGHT + 10.5 * H);
    expect(plan).toEqual({ alerts: [], offlineAlertedAt: null, lowBatteryAlertedAt: null });
  });
});
