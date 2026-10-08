import { describe, expect, it } from "vitest";
import {
  BATTERY_HISTORY_TTL_SECONDS,
  MAX_SAMPLES_PER_DAY,
  dayStamp,
  getBatteryHistory,
  recordBatterySample,
  recordRefresh,
} from "../../src/lib/battery-history";
import type { Env } from "../../src/types";

function makeEnv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const env = {
    KV: {
      async get(key: string) {
        const v = store.get(key);
        return v === undefined ? null : JSON.parse(v);
      },
      async put(key: string, value: string, opts?: { expirationTtl?: number }) {
        store.set(key, value);
        ttls.set(key, opts?.expirationTtl);
      },
    },
  } as unknown as Env;
  return { env, store, ttls };
}

const MAC = "aabbccddeeff";
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0) / 1000;
const DAY = 86400;

describe("battery history", () => {
  it("buckets by UTC day", () => {
    expect(dayStamp(T0)).toBe("20261008");
    expect(dayStamp(Date.UTC(2026, 9, 8, 23, 59, 59) / 1000)).toBe("20261008");
    expect(dayStamp(Date.UTC(2026, 9, 9, 0, 0, 0) / 1000)).toBe("20261009");
  });

  it("records samples and refreshes with a 365-day TTL", async () => {
    const { env, ttls } = makeEnv();
    await recordBatterySample(env, MAC, 3.987, T0);
    await recordBatterySample(env, MAC, 3.95, T0 + 3600);
    await recordRefresh(env, MAC, T0 + 10);
    await recordRefresh(env, MAC, T0 + 20);
    const days = await getBatteryHistory(env, MAC, 1, T0 + 7200);
    expect(days).toEqual([
      {
        date: "2026-10-08",
        samples: [{ t: T0, v: 3.99 }, { t: T0 + 3600, v: 3.95 }],
        refreshes: 2,
      },
    ]);
    expect([...ttls.values()].every((t) => t === BATTERY_HISTORY_TTL_SECONDS)).toBe(true);
    expect(BATTERY_HISTORY_TTL_SECONDS).toBe(365 * DAY);
  });

  it("returns a continuous oldest-first range including empty days", async () => {
    const { env } = makeEnv();
    await recordBatterySample(env, MAC, 4.0, T0 - 2 * DAY);
    const days = await getBatteryHistory(env, MAC, 3, T0);
    expect(days.map((d) => d.date)).toEqual(["2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(days.map((d) => d.samples.length)).toEqual([1, 0, 0]);
    expect(days[2]?.refreshes).toBe(0);
  });

  it("keeps devices separate and caps samples per day", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < MAX_SAMPLES_PER_DAY + 5; i++) await recordBatterySample(env, MAC, 3.8, T0 + i);
    await recordBatterySample(env, "112233445566", 3.2, T0);
    const mine = (await getBatteryHistory(env, MAC, 1, T0))[0]!;
    expect(mine.samples).toHaveLength(MAX_SAMPLES_PER_DAY);
    expect(mine.samples.at(-1)?.t).toBe(T0 + MAX_SAMPLES_PER_DAY + 4);
    const other = (await getBatteryHistory(env, "112233445566", 1, T0))[0]!;
    expect(other.samples).toHaveLength(1);
  });
});
