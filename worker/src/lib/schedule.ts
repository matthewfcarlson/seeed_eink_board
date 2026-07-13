import type { Env, ScheduleConfig } from "../types";
import { kvKeys } from "./kv-keys";

const SCHEDULE_CACHE_TTL_SECONDS = 300;

const SCHEDULE_KEYS = [
  "refresh_interval_minutes",
  "active_start_hour",
  "active_end_hour",
  "timezone_offset_minutes",
] as const;

type ScheduleRow = {
  refresh_interval_minutes: number | null;
  active_start_hour: number | null;
  active_end_hour: number | null;
  timezone_offset_minutes: number | null;
} | null;

const NONE_SENTINEL = "__none__";

/** Row-exists-or-not for one exact target, cached in KV, backed by D1. */
async function getScheduleOverride(env: Env, target: string): Promise<ScheduleConfig | null> {
  const cacheKey = kvKeys.schedule(target);
  const cached = await env.KV.get(cacheKey, "text");
  if (cached !== null) {
    if (cached === NONE_SENTINEL) return null;
    return JSON.parse(cached) as ScheduleConfig;
  }

  const row = await env.DB.prepare(
    `SELECT refresh_interval_minutes, active_start_hour, active_end_hour, timezone_offset_minutes
     FROM schedule_overrides WHERE target = ?`
  )
    .bind(target)
    .first<ScheduleRow>();

  if (!row) {
    await env.KV.put(cacheKey, NONE_SENTINEL, { expirationTtl: SCHEDULE_CACHE_TTL_SECONDS });
    return null;
  }

  const config: ScheduleConfig = {};
  for (const key of SCHEDULE_KEYS) {
    const value = row[key];
    if (value !== null && value !== undefined) config[key] = value;
  }
  await env.KV.put(cacheKey, JSON.stringify(config), { expirationTtl: SCHEDULE_CACHE_TTL_SECONDS });
  return config;
}

/** Call after any admin schedule save/clear for `target` so the next resolution re-reads D1. */
export async function invalidateScheduleCache(env: Env, target: string): Promise<void> {
  await env.KV.delete(kvKeys.schedule(target));
}

/**
 * Resolve schedule config: this device's own override, or {} ("none") if it
 * has never set one. Deliberately no shared 'global'/'default' fallback tier —
 * that was a Worker-only addition on top of image_server.py, which only ever
 * applied a schedule to the handful of devices that had one, and letting any
 * authenticated user write a single shared row every other tenant's unconfigured
 * devices inherited was a cross-tenant griefing vector (see privacy review,
 * 2026-07-13). A device with no override of its own just runs on the firmware's
 * own compiled-in default until its owner sets one explicitly.
 */
export async function resolveScheduleConfig(
  env: Env,
  deviceKey: string
): Promise<{ config: ScheduleConfig; source: string }> {
  const config = await getScheduleOverride(env, deviceKey);
  return config !== null ? { config, source: deviceKey } : { config: {}, source: "none" };
}
