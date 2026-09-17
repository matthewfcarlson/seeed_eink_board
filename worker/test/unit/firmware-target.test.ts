import { describe, expect, it } from "vitest";
import { resolveFirmwareTarget } from "../../src/lib/firmware-target";
import type { Env } from "../../src/types";

/** Fake KV + D1 covering firmware_targets (channel) and firmware_releases (per-board latest). */
function fakeEnv(opts: {
  channel?: "stable" | "beta";
  releases: Record<string, { version: string; sha256: string }>; // board -> newest release
}): Env {
  const kv = new Map<string, string>();
  const KV = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      kv.set(key, value);
    },
    delete: async (key: string) => {
      kv.delete(key);
    },
  } as unknown as Env["KV"];

  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          if (sql.includes("FROM firmware_targets")) {
            return opts.channel ? ({ channel: opts.channel } as unknown as T) : null;
          }
          if (sql.includes("FROM firmware_releases")) {
            const [board] = args as [string];
            const release = opts.releases[board];
            return release ? (release as unknown as T) : null;
          }
          throw new Error(`fakeDb: unrecognized query: ${sql}`);
        },
      }),
    }),
  } as unknown as Env["DB"];

  return { KV, DB } as Env;
}

describe("resolveFirmwareTarget", () => {
  it("resolves to the newest cataloged release for the device's own board when on the stable channel", async () => {
    const env = fakeEnv({ channel: "stable", releases: { "ee02-13in3": { version: "1.2.0", sha256: "abc" } } });
    expect(await resolveFirmwareTarget(env, "aa:bb", "ee02-13in3")).toEqual({ version: "1.2.0", sha256: "abc" });
  });

  it("resolves per the request's own board, not any cached/stale board", async () => {
    const env = fakeEnv({
      channel: "stable",
      releases: {
        "ee02-13in3": { version: "1.0.0", sha256: "aaa" },
        "ee04-7in3": { version: "2.0.0", sha256: "bbb" },
      },
    });
    expect(await resolveFirmwareTarget(env, "dev-1", "ee04-7in3")).toEqual({ version: "2.0.0", sha256: "bbb" });
  });

  it("returns null when no channel has ever been set for this device", async () => {
    const env = fakeEnv({ releases: { "ee02-13in3": { version: "1.0.0", sha256: "aaa" } } });
    expect(await resolveFirmwareTarget(env, "unset-device", "ee02-13in3")).toBeNull();
  });

  it("returns null on the beta channel (no beta pipeline exists yet)", async () => {
    const env = fakeEnv({ channel: "beta", releases: { "ee02-13in3": { version: "1.0.0", sha256: "aaa" } } });
    expect(await resolveFirmwareTarget(env, "beta-device", "ee02-13in3")).toBeNull();
  });

  it("returns null when stable but no release has been cataloged yet for this board", async () => {
    const env = fakeEnv({ channel: "stable", releases: {} });
    expect(await resolveFirmwareTarget(env, "dev-1", "ee02-13in3")).toBeNull();
  });
});
