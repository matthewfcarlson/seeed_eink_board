import { describe, expect, it } from "vitest";
import {
  BATTERY_HISTORY_TTL_SECONDS,
  getBatteryHistory,
  isoDay,
  recordBatterySample,
  recordRefresh,
} from "../../src/lib/battery-history";
import type { Env } from "../../src/types";

/** In-memory KV with list() semantics that matter here: ascending key order,
 *  prefix filter, cursor paging, and metadata on listed keys. */
function makeEnv(pageSize = 1000) {
  const store = new Map<string, { value: string; metadata?: unknown; ttl?: number }>();
  let listCalls = 0;
  const env = {
    KV: {
      async put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }) {
        store.set(key, { value, metadata: opts?.metadata, ttl: opts?.expirationTtl });
      },
      async list({ prefix = "", cursor }: { prefix?: string; cursor?: string }) {
        listCalls++;
        const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const from = cursor ? Number(cursor) : 0;
        const slice = names.slice(from, from + pageSize);
        const done = from + pageSize >= names.length;
        return {
          keys: slice.map((name) => ({ name, metadata: store.get(name)!.metadata })),
          list_complete: done,
          cursor: done ? undefined : String(from + pageSize),
        };
      },
    },
  } as unknown as Env;
  return { env, store, calls: () => listCalls };
}

const MAC = "aabbccddeeff";
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0) / 1000;
const DAY = 86400;

describe("battery history", () => {
  it("formats UTC days", () => {
    expect(isoDay(T0)).toBe("2026-10-08");
    expect(isoDay(Date.UTC(2026, 9, 8, 23, 59, 59) / 1000)).toBe("2026-10-08");
    expect(isoDay(Date.UTC(2026, 9, 9, 0, 0, 0) / 1000)).toBe("2026-10-09");
  });

  it("writes one key per event with a 365-day TTL and returns them in time order", async () => {
    const { env, store } = makeEnv();
    await recordBatterySample(env, MAC, 3.987, T0);
    await recordBatterySample(env, MAC, 3.95, T0 + 3600);
    await recordRefresh(env, MAC, T0 + 10);
    await recordRefresh(env, MAC, T0 + 20);
    expect(store.size).toBe(4);
    expect([...store.values()].every((e) => e.ttl === BATTERY_HISTORY_TTL_SECONDS)).toBe(true);
    expect(BATTERY_HISTORY_TTL_SECONDS).toBe(365 * DAY);
    expect(await getBatteryHistory(env, MAC, 1, T0 + 7200)).toEqual([
      { date: "2026-10-08", samples: [{ t: T0, v: 3.99 }, { t: T0 + 3600, v: 3.95 }], refreshes: 2 },
    ]);
  });

  it("returns a continuous oldest-first range including empty days", async () => {
    const { env } = makeEnv();
    await recordBatterySample(env, MAC, 4.0, T0 - 2 * DAY);
    const days = await getBatteryHistory(env, MAC, 3, T0);
    expect(days.map((d) => d.date)).toEqual(["2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(days.map((d) => d.samples.length)).toEqual([1, 0, 0]);
  });

  it("only reads the device's own keys", async () => {
    const { env } = makeEnv();
    await recordBatterySample(env, MAC, 3.8, T0);
    await recordBatterySample(env, "aabbccddeef0", 3.2, T0);
    const [day] = await getBatteryHistory(env, MAC, 1, T0);
    expect(day?.samples).toEqual([{ t: T0, v: 3.8 }]);
  });

  it("pages through the list and stops once past the requested range", async () => {
    const { env, calls } = makeEnv(10);
    for (let i = 0; i < 100; i++) await recordBatterySample(env, MAC, 3.7, T0 - i * DAY);
    const days = await getBatteryHistory(env, MAC, 7, T0);
    expect(days.reduce((n, d) => n + d.samples.length, 0)).toBe(7);
    expect(calls()).toBe(1); // 7 newest entries fit in the first page; the 8th key proves the range is over
    const all = await getBatteryHistory(env, MAC, 100, T0);
    expect(all.reduce((n, d) => n + d.samples.length, 0)).toBe(100);
  });
});
