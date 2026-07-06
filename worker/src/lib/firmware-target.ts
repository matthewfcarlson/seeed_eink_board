import type { Env } from "../types";
import { DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET } from "../types";
import { kvKeys } from "./kv-keys";

const FIRMWARE_TARGET_CACHE_TTL_SECONDS = 300;
const NONE_SENTINEL = "__none__";

/** Exact override row for `target` (or null), cached in KV, backed by D1. Same
 *  shape as lib/schedule.ts's getScheduleOverride — kept separate rather than
 *  generalized since the two tables have unrelated columns and lifecycles. */
async function getFirmwareTargetOverride(env: Env, target: string): Promise<string | null> {
  const cacheKey = kvKeys.firmwareTarget(target);
  const cached = await env.KV.get(cacheKey, "text");
  if (cached !== null) return cached === NONE_SENTINEL ? null : cached;

  const row = await env.DB.prepare("SELECT version FROM firmware_targets WHERE target = ?")
    .bind(target)
    .first<{ version: string }>();

  const version = row?.version ?? null;
  await env.KV.put(cacheKey, version ?? NONE_SENTINEL, { expirationTtl: FIRMWARE_TARGET_CACHE_TTL_SECONDS });
  return version;
}

export async function invalidateFirmwareTargetCache(env: Env, target: string): Promise<void> {
  await env.KV.delete(kvKeys.firmwareTarget(target));
}

/**
 * Resolve which firmware version `deviceKey` should be running, using the same
 * fallback chain as lib/schedule.ts's resolveScheduleConfig: exact device ->
 * 'default' -> 'global'. Returns null ("none") if nothing has ever been targeted,
 * which means "don't touch the device's firmware" — devices only ever OTA when
 * an admin has explicitly set a target version somewhere in the chain.
 */
export async function resolveFirmwareTarget(env: Env, deviceKey: string): Promise<string | null> {
  const chain =
    deviceKey === DEFAULT_DEVICE_KEY
      ? [DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET]
      : [deviceKey, DEFAULT_DEVICE_KEY, GLOBAL_SCHEDULE_TARGET];

  for (const target of chain) {
    const version = await getFirmwareTargetOverride(env, target);
    if (version !== null) return version;
  }
  return null;
}
