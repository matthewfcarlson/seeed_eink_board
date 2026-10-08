import type { Env } from "../types";
import { kvKeys } from "./kv-keys";

/**
 * Per-device battery + refresh history, KV only (no D1 table): one record per
 * device per UTC day, each expiring 365 days after its last write, so the
 * history prunes itself and a removed device's data ages out on its own.
 *
 * Day-bucketed rather than one growing array per device so a hot path never
 * rewrites a year of data, and so a chart range maps to a bounded number of
 * parallel `get`s (<= MAX_HISTORY_DAYS). Written from /device_config (battery
 * sample, the one request that already carries X-Battery-Voltage) and
 * /image_packed (refresh count, only when a real image is served).
 */

export const BATTERY_HISTORY_TTL_SECONDS = 365 * 24 * 60 * 60;
export const MAX_HISTORY_DAYS = 365;
/** Per-day sample cap; a device on a 1-minute interval would otherwise grow a record unbounded. */
export const MAX_SAMPLES_PER_DAY = 96;

/** `s`: [epochSeconds, volts] pairs in time order. `r`: images served that day. */
type DayRecord = { s: [number, number][]; r: number };

export type BatteryHistoryDay = {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  samples: { t: number; v: number }[];
  refreshes: number;
};

/** Epoch seconds -> UTC "YYYYMMDD", the day component of the KV key. */
export function dayStamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return (
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

function isoDate(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

async function readDay(env: Env, mac: string, stamp: string): Promise<DayRecord> {
  const rec = await env.KV.get<DayRecord>(kvKeys.batteryDay(mac, stamp), "json");
  return rec && Array.isArray(rec.s) ? { s: rec.s, r: Number(rec.r) || 0 } : { s: [], r: 0 };
}

async function writeDay(env: Env, mac: string, stamp: string, rec: DayRecord): Promise<void> {
  await env.KV.put(kvKeys.batteryDay(mac, stamp), JSON.stringify(rec), {
    expirationTtl: BATTERY_HISTORY_TTL_SECONDS,
  });
}

export async function recordBatterySample(env: Env, mac: string, voltage: number, now: number): Promise<void> {
  const stamp = dayStamp(now);
  const rec = await readDay(env, mac, stamp);
  rec.s.push([now, Math.round(voltage * 100) / 100]);
  if (rec.s.length > MAX_SAMPLES_PER_DAY) rec.s = rec.s.slice(-MAX_SAMPLES_PER_DAY);
  await writeDay(env, mac, stamp, rec);
}

export async function recordRefresh(env: Env, mac: string, now: number): Promise<void> {
  const stamp = dayStamp(now);
  const rec = await readDay(env, mac, stamp);
  rec.r += 1;
  await writeDay(env, mac, stamp, rec);
}

/** Oldest-first list of the last `days` UTC days (today included); empty days are kept so charts get a continuous axis. */
export async function getBatteryHistory(env: Env, mac: string, days: number, now: number): Promise<BatteryHistoryDay[]> {
  const n = Math.max(1, Math.min(MAX_HISTORY_DAYS, Math.floor(days)));
  const stamps: string[] = [];
  for (let i = n - 1; i >= 0; i--) stamps.push(dayStamp(now - i * 86400));
  const records = await Promise.all(stamps.map((s) => readDay(env, mac, s)));
  return stamps.map((stamp, i) => {
    const rec = records[i] ?? { s: [], r: 0 };
    return { date: isoDate(stamp), samples: rec.s.map(([t, v]) => ({ t, v })), refreshes: rec.r };
  });
}
