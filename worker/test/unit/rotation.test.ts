import { describe, expect, it } from "vitest";
import { getRotationSnapshot, markServed, peekPendingImage } from "../../src/lib/rotation";
import type { Env, ImageMeta, RotationSnapshot } from "../../src/types";

function image(id: string): ImageMeta {
  return {
    id,
    filename: `${id}.bin`,
    packedHash: `hash-${id}`,
    packedBytes: 960_000,
    packedEncoding: "identity",
    sourceDeviceKey: "device-1",
    keyVersion: 1,
  };
}

/** Minimal in-memory KV — enough of get/put for rotation.ts's own calls. */
function fakeKv(): Env["KV"] {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as Env["KV"];
}

describe("peekPendingImage", () => {
  it("returns null for an empty rotation", () => {
    const snapshot: RotationSnapshot = { currentIndex: 0, lastReturned: null, images: [] };
    expect(peekPendingImage(snapshot)).toBeNull();
  });

  it("returns the image at currentIndex without mutating anything", () => {
    const snapshot: RotationSnapshot = { currentIndex: 1, lastReturned: "a", images: [image("a"), image("b")] };
    expect(peekPendingImage(snapshot)).toEqual({ image: image("b"), index: 1 });
  });

  it("clamps an out-of-range currentIndex back to 0 (e.g. the pointed-at image was deleted)", () => {
    const snapshot: RotationSnapshot = { currentIndex: 5, lastReturned: "a", images: [image("a"), image("b")] };
    expect(peekPendingImage(snapshot)).toEqual({ image: image("a"), index: 0 });
  });
});

describe("markServed", () => {
  it("advances the cursor to the next index and records lastReturned, and the returned thunk mirrors it into D1", async () => {
    const kv = fakeKv();
    let mirroredArgs: unknown[] | null = null;
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (!sql.includes("INSERT INTO rotation_state")) throw new Error(`unexpected query: ${sql}`);
            mirroredArgs = args;
            return {};
          },
        }),
      }),
    } as unknown as Env["DB"];
    const env = { KV: kv, DB: db } as Env;
    const snapshot: RotationSnapshot = { currentIndex: 0, lastReturned: null, images: [image("a"), image("b")] };
    const mirror = await markServed(env, "device-1", snapshot, 0, "a");

    const updated = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(updated).toEqual({ currentIndex: 1, lastReturned: "a", images: snapshot.images });

    // The D1 mirror is a separate thunk the caller passes to ctx.waitUntil() -
    // KV is updated synchronously above; D1 only catches up once this runs.
    expect(mirroredArgs).toBeNull();
    await mirror();
    expect(mirroredArgs).toEqual(["device-1", 1, "a", expect.any(Number)]);
  });

  it("wraps around to index 0 after serving the last image", async () => {
    const kv = fakeKv();
    const env = { KV: kv } as Env;
    const snapshot: RotationSnapshot = { currentIndex: 1, lastReturned: "a", images: [image("a"), image("b")] };
    await markServed(env, "device-1", snapshot, 1, "b");

    const updated = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(updated?.currentIndex).toBe(0);
    expect(updated?.lastReturned).toBe("b");
  });
});

describe("getRotationSnapshot", () => {
  it("returns the cached snapshot from KV without touching D1", async () => {
    const kv = fakeKv();
    const cached: RotationSnapshot = { currentIndex: 2, lastReturned: "z", images: [image("z")] };
    await kv.put("rotation:device-1", JSON.stringify(cached));
    const db = {
      prepare: () => {
        throw new Error("should not query D1 on a KV cache hit");
      },
    } as unknown as Env["DB"];
    const env = { KV: kv, DB: db } as Env;
    expect(await getRotationSnapshot(env, "device-1")).toEqual(cached);
  });

  it("rebuilds from D1 (merging every subscribed bucket, sorted by filename) on a KV miss and re-seeds the cache", async () => {
    const kv = fakeKv();
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("FROM device_buckets")) {
              return { results: [{ bucket_id: "bucket-a" }, { bucket_id: "bucket-b" }] };
            }
            if (sql.includes("FROM images") && sql.includes("device_key = ?")) {
              // Called once per bucket id; return one image with a filename that
              // sorts differently per bucket to prove the final merge re-sorts.
              const [deviceKey] = _args as [string];
              const row =
                deviceKey === "bucket-a"
                  ? { id: "img-z", filename: "z.bin", packed_hash: "h1", packed_bytes: 1, key_version: 1, packed_encoding: "identity" }
                  : { id: "img-a", filename: "a.bin", packed_hash: "h2", packed_bytes: 1, key_version: 1, packed_encoding: "identity" };
              return { results: [row] };
            }
            throw new Error(`unexpected all() query: ${sql}`);
          },
          first: async () => null, // no rotation_state row yet
        }),
      }),
    } as unknown as Env["DB"];
    const env = { KV: kv, DB: db } as Env;

    const snapshot = await getRotationSnapshot(env, "device-1");
    expect(snapshot.currentIndex).toBe(0);
    expect(snapshot.lastReturned).toBeNull();
    expect(snapshot.images.map((i) => i.filename)).toEqual(["a.bin", "z.bin"]); // merged + re-sorted

    // Re-seeded into KV for next time.
    const cached = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(cached?.images.map((i) => i.filename)).toEqual(["a.bin", "z.bin"]);
  });
});
