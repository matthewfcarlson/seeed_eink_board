import { describe, expect, it } from "vitest";
import { assertBucketAccess, assertBucketReadAccess } from "../../src/lib/bucket-access";
import type { Env } from "../../src/types";

/**
 * Minimal fake D1Database — just enough of the prepare().bind().first()
 * chain that bucket-access.ts actually calls, dispatched by matching the SQL
 * text rather than a real SQLite engine. Lets assertBucketAccess/
 * assertBucketReadAccess run their real code paths (including the exact
 * queries they issue) without spinning up Miniflare/D1 for a plain unit test.
 */
function fakeDb(opts: {
  buckets: Record<string, { owner_id: string | null; is_public: number }>;
  shares: Set<string>; // `${bucketId}:${userId}`
}): Env["DB"] {
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("FROM buckets")) {
          const bucketId = args[0] as string;
          const bucket = opts.buckets[bucketId];
          if (!bucket) return null;
          if (sql.includes("is_public")) return { is_public: bucket.is_public } as unknown as T;
          return { owner_id: bucket.owner_id } as unknown as T;
        }
        if (sql.includes("FROM bucket_shares")) {
          const [bucketId, userId] = args as [string, string];
          return opts.shares.has(`${bucketId}:${userId}`) ? ({} as T) : null;
        }
        throw new Error(`fakeDb: unrecognized query: ${sql}`);
      },
    }),
  });
  return { prepare } as unknown as Env["DB"];
}

describe("assertBucketAccess", () => {
  it("grants the owner", async () => {
    const env = { DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 0 } }, shares: new Set() }) } as Env;
    expect(await assertBucketAccess(env, "b1", "owner-1")).toBe(true);
  });

  it("grants an accepted collaborator", async () => {
    const env = {
      DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 0 } }, shares: new Set(["b1:collab-1"]) }),
    } as Env;
    expect(await assertBucketAccess(env, "b1", "collab-1")).toBe(true);
  });

  it("denies an unrelated user", async () => {
    const env = { DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 0 } }, shares: new Set() }) } as Env;
    expect(await assertBucketAccess(env, "b1", "stranger")).toBe(false);
  });

  it("denies access to a public bucket for a non-owner/non-collaborator (writes stay gated)", async () => {
    const env = { DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 1 } }, shares: new Set() }) } as Env;
    expect(await assertBucketAccess(env, "b1", "stranger")).toBe(false);
  });

  it("denies a nonexistent bucket", async () => {
    const env = { DB: fakeDb({ buckets: {}, shares: new Set() }) } as Env;
    expect(await assertBucketAccess(env, "missing", "anyone")).toBe(false);
  });
});

describe("assertBucketReadAccess", () => {
  it("grants the owner, same as assertBucketAccess", async () => {
    const env = { DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 0 } }, shares: new Set() }) } as Env;
    expect(await assertBucketReadAccess(env, "b1", "owner-1")).toBe(true);
  });

  it("grants an accepted collaborator, same as assertBucketAccess", async () => {
    const env = {
      DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 0 } }, shares: new Set(["b1:collab-1"]) }),
    } as Env;
    expect(await assertBucketReadAccess(env, "b1", "collab-1")).toBe(true);
  });

  it("grants a stranger read access to a public bucket", async () => {
    const env = { DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 1 } }, shares: new Set() }) } as Env;
    expect(await assertBucketReadAccess(env, "b1", "stranger")).toBe(true);
  });

  it("still denies a stranger on a private (non-public) bucket", async () => {
    const env = { DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 0 } }, shares: new Set() }) } as Env;
    expect(await assertBucketReadAccess(env, "b1", "stranger")).toBe(false);
  });

  it("denies a nonexistent bucket", async () => {
    const env = { DB: fakeDb({ buckets: {}, shares: new Set() }) } as Env;
    expect(await assertBucketReadAccess(env, "missing", "anyone")).toBe(false);
  });

  it("does not require a public bucket's owner to also have a bucket_shares row", async () => {
    // The owner check in assertBucketAccess (reused internally) always short
    // circuits before any bucket_shares lookup — this just documents that a
    // public bucket's owner is never treated as merely "a public reader".
    const env = { DB: fakeDb({ buckets: { b1: { owner_id: "owner-1", is_public: 1 } }, shares: new Set() }) } as Env;
    expect(await assertBucketReadAccess(env, "b1", "owner-1")).toBe(true);
  });
});
