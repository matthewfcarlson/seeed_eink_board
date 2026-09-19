import { describe, expect, it } from "vitest";
import { checkRateLimit, RATE_LIMITS } from "../../src/lib/rate-limit";
import type { Env } from "../../src/types";

/** Minimal D1 stand-in implementing exactly the upsert+RETURNING semantics
 *  checkRateLimit relies on (same pattern as device-signature.test.ts's fake). */
function makeEnv() {
  const rows = new Map<string, number>();
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const bound = {
          bind(...bindArgs: unknown[]) {
            args = bindArgs;
            return bound;
          },
          async first<T>(): Promise<T | null> {
            if (sql.includes("INSERT INTO rate_limits")) {
              const key = args[0] as string;
              rows.set(key, (rows.get(key) ?? 0) + 1);
              return { count: rows.get(key) } as unknown as T;
            }
            return null;
          },
          async run() {
            if (sql.includes("DELETE FROM rate_limits")) {
              const prefix = (args[0] as string).replace(/%$/, "");
              for (const k of [...rows.keys()]) {
                if (k.startsWith(prefix) && k !== args[1]) rows.delete(k);
              }
            }
            return { meta: {} };
          },
        };
        return bound;
      },
    },
  } as unknown as Env;
  return { env, rows };
}

describe("checkRateLimit", () => {
  it("allows requests under the limit and rejects once over", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < RATE_LIMITS.auth.limit; i++) {
      expect(await checkRateLimit(env, "auth", "[IP_ADDRESS]", RATE_LIMITS.auth.limit, RATE_LIMITS.auth.windowSeconds)).toBe(true);
    }
    expect(await checkRateLimit(env, "auth", "[IP_ADDRESS]", RATE_LIMITS.auth.limit, RATE_LIMITS.auth.windowSeconds)).toBe(false);
  });

  it("counts identities independently", async () => {
    const { env } = makeEnv();
    expect(await checkRateLimit(env, "auth", "a", 1, 60)).toBe(true);
    expect(await checkRateLimit(env, "auth", "b", 1, 60)).toBe(true);
    expect(await checkRateLimit(env, "auth", "a", 1, 60)).toBe(false);
  });

  it("keys limiters independently (auth traffic doesn't consume device budget)", async () => {
    const { env } = makeEnv();
    expect(await checkRateLimit(env, "auth", "x", 1, 60)).toBe(true);
    expect(await checkRateLimit(env, "device", "x", 1, 60)).toBe(true);
  });

  it("fails open on a D1 error", async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              throw new Error("d1 down");
            },
            async run() {
              return { meta: {} };
            },
          };
        },
      },
    } as unknown as Env;
    expect(await checkRateLimit(env, "auth", "x", 1, 60)).toBe(true);
  });
});
