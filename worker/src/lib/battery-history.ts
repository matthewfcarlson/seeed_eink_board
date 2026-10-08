import type { Env } from "../types";
import { kvKeys } from "./kv-keys";

/**
 * Per-device battery + refresh history, KV only (no D1 table). Every battery
 * sample and every served image is its own key, `hist:v1:<mac>:<rev>:<b|r>`,
 * expiring 365 days after it was written — so the history prunes itself, a
 * removed device's data ages out, and writes never read-modify-write (no lost
 * updates). The battery voltage rides in the key's *metadata*, so one
 * KV.list() returns the whole series with no per-key get.
 *
 * `rev` is MAX_EPOCH - epochSeconds, zero-padded: list() is ascending-only
 * with no start key, so reversing the timestamp puts the newest entries first
 * and a "last 7 days" read stops paging as soon as it passes the range instead
 * of walking a year of keys.
 *
 * Written from /device_config (battery sample, the request that carries
 * X-Battery-Voltage) and /image_packed (refresh, only when a real image is
 * served).
 */

export const BATTERY_HISTORY_TTL_SECONDS = 365 * 24 * 60 * 60;
export const MAX_HISTORY_DAYS = 365;
/** Hard stop on list pages (1,000 keys each) so a runaway device can't blow the subrequest limit. */
const MAX_LIST_PAGES = 40;
const MAX_EPOCH = 9_999_999_999;

type EntryMeta = { v?: number };

export type BatteryHistoryDay = {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  samples: { t: number; v: number }[];
  refreshes: number;
};

function revStamp(epochSeconds: number): string {
  return String(MAX_EPOCH - epochSeconds).padStart(10, "0");
}

/** Epoch seconds -> UTC "YYYY-MM-DD". */
export function isoDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export async function recordBatterySample(env: Env, mac: string, voltage: number, now: number): Promise<void> {
  const v = Math.round(voltage * 100) / 100;
  await env.KV.put(kvKeys.historyEntry(mac, revStamp(now), "b"), String(v), {
    expirationTtl: BATTERY_HISTORY_TTL_SECONDS,
    metadata: { v } satisfies EntryMeta,
  });
}

export async function recordRefresh(env: Env, mac: string, now: number): Promise<void> {
  await env.KV.put(kvKeys.historyEntry(mac, revStamp(now), "r"), "1", {
    expirationTtl: BATTERY_HISTORY_TTL_SECONDS,
  });
}

/** Oldest-first list of the last `days` UTC days (today included); empty days are kept so charts get a continuous axis. */
export async function getBatteryHistory(env: Env, mac: string, days: number, now: number): Promise<BatteryHistoryDay[]> {
  const n = Math.max(1, Math.min(MAX_HISTORY_DAYS, Math.floor(days)));
  const buckets: BatteryHistoryDay[] = [];
  const byDate = new Map<string, BatteryHistoryDay>();
  for (let i = n - 1; i >= 0; i--) {
    const bucket: BatteryHistoryDay = { date: isoDay(now - i * 86400), samples: [], refreshes: 0 };
    buckets.push(bucket);
    byDate.set(bucket.date, bucket);
  }
  const firstDate = buckets[0]!.date;
  const startEpoch = Date.parse(firstDate + "T00:00:00Z") / 1000;

  const prefix = kvKeys.historyPrefix(mac);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await env.KV.list<EntryMeta>({ prefix, cursor });
    let reachedStart = false;
    for (const key of res.keys) {
      const [revPart, kind] = key.name.slice(prefix.length).split(":");
      const t = MAX_EPOCH - Number(revPart);
      if (!Number.isFinite(t)) continue;
      if (t < startEpoch) {
        reachedStart = true; // newest-first: everything after this is older still
        break;
      }
      const bucket = byDate.get(isoDay(t));
      if (!bucket) continue; // future-dated (clock skew), outside the range
      if (kind === "r") bucket.refreshes += 1;
      else if (typeof key.metadata?.v === "number") bucket.samples.push({ t, v: key.metadata.v });
    }
    if (reachedStart || res.list_complete) break;
    cursor = res.cursor;
  }
  // Keys arrived newest-first; charts want time order.
  for (const b of buckets) b.samples.reverse();
  return buckets;
}
