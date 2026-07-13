import type { Env } from "../types";
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
 * Resolve which firmware version `deviceKey` should be running: this exact
 * device's own target, or null ("none") if no one has ever targeted it —
 * which means "don't touch this device's firmware." Deliberately no shared
 * 'default'/'global' fallback tier (see lib/schedule.ts's resolveScheduleConfig
 * for the matching rationale) — a bad flash can brick this board (no
 * rollback-on-crash), so letting any authenticated user push a version onto
 * every other tenant's un-targeted devices via one shared row was a real
 * cross-tenant risk, not just a config convenience.
 */
export async function resolveFirmwareTarget(env: Env, deviceKey: string): Promise<string | null> {
  return getFirmwareTargetOverride(env, deviceKey);
}
