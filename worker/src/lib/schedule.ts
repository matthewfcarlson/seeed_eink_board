import type { Env, ScheduleConfig } from "../types";
import { DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET } from "../types";
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
 * Resolve schedule config using the exact same fallback chain as
 * image_server.py's get_device_schedule_config: exact device override ->
 * 'default' override -> 'global' override -> {} ("none"). First *existing*
 * override file wins outright — this is not a per-field merge.
 */
export async function resolveScheduleConfig(
  env: Env,
  deviceKey: string
): Promise<{ config: ScheduleConfig; source: string }> {
  const chain =
    deviceKey === DEFAULT_DEVICE_KEY
      ? [DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET]
      : [deviceKey, DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET];

  for (const target of chain) {
    const config = await getScheduleOverride(env, target);
    if (config !== null) return { config, source: target };
  }
  return { config: {}, source: "none" };
}
