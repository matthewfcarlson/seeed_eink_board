import type { Env } from "../types";
import { kvKeys } from "./kv-keys";

const FIRMWARE_TARGET_CACHE_TTL_SECONDS = 300;
const NONE_SENTINEL = "__none__";

export type FirmwareChannel = "stable" | "beta";

export interface ResolvedFirmware {
  version: string;
  sha256: string;
}

/** Exact override row for `target` (or null), cached in KV, backed by D1. Same
 *  shape as lib/schedule.ts's getScheduleOverride — kept separate rather than
 *  generalized since the two tables have unrelated columns and lifecycles. */
async function getFirmwareChannel(env: Env, target: string): Promise<FirmwareChannel | null> {
  const cacheKey = kvKeys.firmwareTarget(target);
  const cached = await env.KV.get(cacheKey, "text");
  if (cached !== null) return cached === NONE_SENTINEL ? null : (cached as FirmwareChannel);

  const row = await env.DB.prepare("SELECT channel FROM firmware_targets WHERE target = ?")
    .bind(target)
    .first<{ channel: FirmwareChannel }>();

  const channel = row?.channel ?? null;
  await env.KV.put(cacheKey, channel ?? NONE_SENTINEL, { expirationTtl: FIRMWARE_TARGET_CACHE_TTL_SECONDS });
  return channel;
}

export async function invalidateFirmwareTargetCache(env: Env, target: string): Promise<void> {
  await env.KV.delete(kvKeys.firmwareTarget(target));
}

/** The newest cataloged release for a board — "stable" always means whatever
 *  the worker has most recently synced from GitHub for that board, not a
 *  pinned version (see routes/admin/firmware.ts's syncLatestFirmwareRelease). */
async function resolveLatestRelease(env: Env, board: string): Promise<ResolvedFirmware | null> {
  const row = await env.DB.prepare(
    "SELECT version, sha256 FROM firmware_releases WHERE board = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(board)
    .first<{ version: string; sha256: string }>();
  return row ?? null;
}

/**
 * Resolve what firmware `deviceKey` (reporting itself as `board` on this
 * request — see routes/device-config.ts) should be running, or null if
 * nothing should change. No admin-picked exact version anymore — just a
 * two-value channel choice (migrations/0014):
 *   - 'stable' → the newest release cataloged for this device's board.
 *   - 'beta'   → nothing yet (no beta pipeline exists) — same as unset.
 *   - unset    → nothing, same as today's "no target set" behavior.
 * Deliberately no shared 'default'/'global' fallback tier (see
 * lib/schedule.ts's resolveScheduleConfig for the matching rationale) — a bad
 * flash can brick this board (no rollback-on-crash), so letting any
 * authenticated user push firmware onto every other tenant's un-targeted
 * devices via one shared row was a real cross-tenant risk, not just a config
 * convenience.
 */
export async function resolveFirmwareTarget(env: Env, deviceKey: string, board: string): Promise<ResolvedFirmware | null> {
  const channel = await getFirmwareChannel(env, deviceKey);
  if (channel !== "stable") return null; // 'beta' and unset both resolve to nothing for now
  return resolveLatestRelease(env, board);
}
