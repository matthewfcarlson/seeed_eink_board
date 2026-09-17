import { describe, expect, it } from "vitest";
import { resolveDeviceKey } from "../../src/lib/auth-device";
import { DEFAULT_DEVICE_KEY, type Env } from "../../src/types";

function fakeEnv(row: { mac: string; user_id: string | null; secret: string | null } | null): {
  env: Env;
  kv: Map<string, string>;
} {
  const kv = new Map<string, string>();
  const KV = {
    get: async (key: string) => (kv.has(key) ? JSON.parse(kv.get(key)!) : null),
    put: async (key: string, value: string) => {
      kv.set(key, value);
    },
    delete: async (key: string) => {
      kv.delete(key);
    },
  } as unknown as Env["KV"];
  const DB = {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
      }),
    }),
  } as unknown as Env["DB"];
  return { env: { KV, DB } as Env, kv };
}

describe("resolveDeviceKey", () => {
  it("resolves a registered device with a secret to its own mac as the device key", async () => {
    const { env } = fakeEnv({ mac: "aabbcc", user_id: "user-1", secret: "shh" });
    expect(await resolveDeviceKey(env, "aabbcc")).toEqual({ deviceKey: "aabbcc", userId: "user-1", secret: "shh" });
  });

  it("falls back to the default sentinel for a device row with no secret set", async () => {
    const { env } = fakeEnv({ mac: "aabbcc", user_id: "user-1", secret: null });
    expect(await resolveDeviceKey(env, "aabbcc")).toEqual({ deviceKey: DEFAULT_DEVICE_KEY, userId: null, secret: null });
  });

  it("falls back to the default sentinel for a completely unregistered mac", async () => {
    const { env } = fakeEnv(null);
    expect(await resolveDeviceKey(env, "unregistered")).toEqual({ deviceKey: DEFAULT_DEVICE_KEY, userId: null, secret: null });
  });

  it("caches the resolution in KV and serves the cached value on a repeat call without re-querying D1", async () => {
    const { env, kv } = fakeEnv({ mac: "aabbcc", user_id: "user-1", secret: "shh" });
    const first = await resolveDeviceKey(env, "aabbcc");
    expect(kv.size).toBe(1);

    // Swap in a DB that would throw if queried again, proving the second call is a pure cache hit.
    const poisoned = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("should not hit D1 on a cache hit");
        },
      },
    } as unknown as Env;
    expect(await resolveDeviceKey(poisoned, "aabbcc")).toEqual(first);
  });
});
