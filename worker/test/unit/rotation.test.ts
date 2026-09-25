import { describe, expect, it } from "vitest";
import { getRotationSnapshot, markServed, peekPendingImage } from "../../src/lib/rotation";
import type { Env, ImageMeta, RotationSnapshot } from "../../src/types";

function image(id: string, bucket = "device-1"): ImageMeta {
  return {
    id,
    filename: `${id}.bin`,
    sourceDeviceKey: bucket,
    keyVersion: 1,
  };
}

function snapshot(images: ImageMeta[], state: Partial<RotationSnapshot> = {}): RotationSnapshot {
  return { lastReturned: null, lastBucketId: null, recentImageIds: [], images, ...state };
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

/** Serves `count` images the way /image_packed does — peek, then markServed —
 *  and returns what came back, in order. */
async function serveMany(deviceKey: string, initial: RotationSnapshot, count: number): Promise<ImageMeta[]> {
  const env = { KV: fakeKv() } as Env;
  let current = initial;
  const served: ImageMeta[] = [];
  for (let i = 0; i < count; i++) {
    const pending = peekPendingImage(deviceKey, current);
    expect(pending).not.toBeNull();
    served.push(pending!);
    await markServed(env, deviceKey, current, pending!);
    current = (await env.KV.get<RotationSnapshot>(`rotation:${deviceKey}`, "json"))!;
  }
  return served;
}

describe("peekPendingImage", () => {
  it("returns null for an empty rotation", () => {
    expect(peekPendingImage("device-1", snapshot([]))).toBeNull();
  });

  it("returns the only image of a single-image rotation, repeatedly", () => {
    const single = snapshot([image("a")], { lastReturned: "a", lastBucketId: "device-1", recentImageIds: ["a"] });
    expect(peekPendingImage("device-1", single)).toEqual(image("a"));
  });

  it("is stable for a given snapshot — /hash and the /image_packed after it must agree", () => {
    const images = [image("a", "bucket-a"), image("b", "bucket-b"), image("c", "bucket-c")];
    const state = snapshot(images, { lastReturned: "a", lastBucketId: "bucket-a", recentImageIds: ["a"] });
    const first = peekPendingImage("device-1", state);
    expect(peekPendingImage("device-1", state)).toEqual(first);
    expect(peekPendingImage("device-1", { ...state, images: [...images] })).toEqual(first);
  });

  it("never picks from the bucket just served when another bucket has images", () => {
    // Deliberately lopsided: a sequential or plain-random pick would sit in
    // bucket-a for 9 out of 10 images.
    const images = [
      ...Array.from({ length: 9 }, (_, i) => image(`a${i}`, "bucket-a")),
      image("b0", "bucket-b"),
    ];
    for (const lastBucketId of ["bucket-a", "bucket-b"]) {
      const pending = peekPendingImage("device-1", snapshot(images, { lastBucketId }));
      expect(pending!.sourceDeviceKey).not.toBe(lastBucketId);
    }
  });

  it("weights the bucket choice by image count among the eligible buckets", () => {
    // Last serve came from bucket-b, so the choice is between bucket-a (8
    // images) and bucket-c (2): weighted, that's 80/20; per-bucket it'd be 50/50.
    const images = [
      ...Array.from({ length: 8 }, (_, i) => image(`a${i}`, "bucket-a")),
      image("b0", "bucket-b"),
      image("c0", "bucket-c"),
      image("c1", "bucket-c"),
    ];
    const state = snapshot(images, { lastBucketId: "bucket-b" });
    const counts: Record<string, number> = {};
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const bucket = peekPendingImage(`device-${i}`, state)!.sourceDeviceKey;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    expect(counts["bucket-b"]).toBeUndefined();
    expect(counts["bucket-a"]! / trials).toBeGreaterThan(0.72);
    expect(counts["bucket-a"]! / trials).toBeLessThan(0.88);
  });

  it("caps a huge bucket's weight so a small one still gets play time", () => {
    // Eligible: dogs (2000) vs art (30). Uncapped that's ~98.5/1.5; capped at
    // 4x the smallest it's 120 vs 30 -> 80/20.
    const images = [
      ...Array.from({ length: 2000 }, (_, i) => image(`dog${i}`, "dogs")),
      ...Array.from({ length: 30 }, (_, i) => image(`art${i}`, "art")),
      image("x0", "other"),
    ];
    const state = snapshot(images, { lastBucketId: "other" });
    let art = 0;
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      if (peekPendingImage(`device-${i}`, state)!.sourceDeviceKey === "art") art++;
    }
    expect(art / trials).toBeGreaterThan(0.14);
    expect(art / trials).toBeLessThan(0.26);
  });

  it("still serves the last-served bucket when it is the only one with images", () => {
    const images = [image("a"), image("b")];
    const pending = peekPendingImage("device-1", snapshot(images, { lastBucketId: "device-1" }));
    expect(pending!.sourceDeviceKey).toBe("device-1");
  });

  it("prefers images outside the recency window", () => {
    // Window is floor(4 / 2) = 2, so 'a' and 'b' are off the table.
    const images = [image("a"), image("b"), image("c"), image("d")];
    const pending = peekPendingImage("device-1", snapshot(images, { recentImageIds: ["a", "b"] }));
    expect(["c", "d"]).toContain(pending!.id);
  });

  it("only honours the newest recentWindow() entries, not the whole stored history", () => {
    // Two images -> window of 1: 'a' is excluded, the older 'b' is fair game again.
    const images = [image("a"), image("b")];
    const pending = peekPendingImage("device-1", snapshot(images, { recentImageIds: ["a", "b"] }));
    expect(pending!.id).toBe("b");
  });

  it("gives two devices sharing the same buckets and state different picks", () => {
    const images = Array.from({ length: 8 }, (_, i) => image(`i${i}`));
    const shared = snapshot(images);
    const a = peekPendingImage("aa:aa:aa:aa:aa:aa", shared);
    const b = peekPendingImage("bb:bb:bb:bb:bb:bb", shared);
    expect(a!.id).not.toBe(b!.id);
  });
});

describe("rotation over successive serves", () => {
  it("alternates buckets and covers every image of a two-bucket rotation", async () => {
    const images = [
      image("a1", "bucket-a"),
      image("a2", "bucket-a"),
      image("b1", "bucket-b"),
      image("b2", "bucket-b"),
    ];
    const served = await serveMany("device-1", snapshot(images), 12);

    for (let i = 1; i < served.length; i++) {
      expect(served[i]!.sourceDeviceKey, `serve ${i} repeated a bucket`).not.toBe(served[i - 1]!.sourceDeviceKey);
    }
    expect(new Set(served.map((img) => img.id))).toEqual(new Set(["a1", "a2", "b1", "b2"]));
  });

  it("does not repeat an image while it is inside the recency window", async () => {
    const images = Array.from({ length: 10 }, (_, i) => image(`i${i}`));
    const served = await serveMany("device-1", snapshot(images), 40);
    const window = 5; // floor(10 / 2)
    for (let i = 0; i < served.length; i++) {
      const previous = served.slice(Math.max(0, i - window), i).map((img) => img.id);
      expect(previous, `serve ${i} repeated ${served[i]!.id} too soon`).not.toContain(served[i]!.id);
    }
  });

  it("never serves the same image twice in a row, even where a bucket is smaller than the recency window", async () => {
    // /image_packed answers 304 when the device already holds the pending
    // image's hash, and a 304 doesn't record a serve — so picking the
    // just-served image again would park the frame on it for good.
    const layouts: Record<string, number>[] = [
      { a: 2 },
      { a: 9, b: 1 }, // b's single image is always inside the window
      { a: 1, b: 1 },
      { a: 10, b: 5, c: 3 },
    ];
    for (const layout of layouts) {
      const images = Object.entries(layout).flatMap(([bucket, count]) =>
        Array.from({ length: count }, (_, i) => image(`${bucket}${i}`, bucket))
      );
      const served = await serveMany("device-1", snapshot(images), 30);
      for (let i = 1; i < served.length; i++) {
        expect(served[i]!.id, `${JSON.stringify(layout)} repeated at serve ${i}`).not.toBe(served[i - 1]!.id);
      }
    }
  });

  it("is not a fixed cycle — a shuffled rotation visits images in varying order", async () => {
    const images = Array.from({ length: 6 }, (_, i) => image(`i${i}`));
    const served = (await serveMany("device-1", snapshot(images), 30)).map((img) => img.id);
    const firstPass = served.slice(0, 6).join(",");
    const laterPasses = [served.slice(6, 12).join(","), served.slice(12, 18).join(",")];
    expect(laterPasses.some((pass) => pass !== firstPass)).toBe(true);
  });
});

describe("markServed", () => {
  it("records the served image, its bucket and the history, and the returned thunk mirrors it into D1", async () => {
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
    const images = [image("a", "bucket-a"), image("b", "bucket-b")];
    const mirror = await markServed(env, "device-1", snapshot(images), images[0]!);

    const updated = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(updated).toEqual({
      lastReturned: "a",
      lastBucketId: "bucket-a",
      recentImageIds: ["a"],
      images,
    });

    // The D1 mirror is a separate thunk the caller passes to ctx.waitUntil() -
    // KV is updated synchronously above; D1 only catches up once this runs.
    expect(mirroredArgs).toBeNull();
    await mirror();
    expect(mirroredArgs).toEqual(["device-1", "a", "bucket-a", '["a"]', expect.any(Number)]);
  });

  it("pushes the newest id to the front of the history without duplicating it", async () => {
    const kv = fakeKv();
    const env = { KV: kv } as Env;
    const images = [image("a"), image("b"), image("c")];
    await markServed(env, "device-1", snapshot(images, { recentImageIds: ["b", "a"] }), images[0]!);

    const updated = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(updated?.recentImageIds).toEqual(["a", "b"]);
  });

  it("drops images that have since left the device's buckets from the history", async () => {
    const kv = fakeKv();
    const env = { KV: kv } as Env;
    const images = [image("a"), image("b")];
    // "gone" was served before its bucket was unassigned (or the image deleted).
    await markServed(env, "device-1", snapshot(images, { recentImageIds: ["gone", "b"] }), images[0]!);

    const updated = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(updated?.recentImageIds).toEqual(["a", "b"]);
  });

  it("caps the stored history so the snapshot can't grow unbounded", async () => {
    const kv = fakeKv();
    const env = { KV: kv } as Env;
    const images = Array.from({ length: 64 }, (_, i) => image(`i${i}`));
    const history = images.slice(1, 33).map((img) => img.id); // already at the 32-id cap
    await markServed(env, "device-1", snapshot(images, { recentImageIds: history }), images[0]!);

    const updated = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(updated?.recentImageIds).toHaveLength(32);
    expect(updated?.recentImageIds[0]).toBe("i0");
    expect(updated?.recentImageIds).not.toContain("i32"); // oldest entry dropped
  });
});

describe("getRotationSnapshot", () => {
  it("returns the cached snapshot from KV without touching D1", async () => {
    const kv = fakeKv();
    const cached = snapshot([image("z")], { lastReturned: "z", lastBucketId: "device-1", recentImageIds: ["z"] });
    await kv.put("rotation:device-1", JSON.stringify(cached));
    const db = {
      prepare: () => {
        throw new Error("should not query D1 on a KV cache hit");
      },
    } as unknown as Env["DB"];
    const env = { KV: kv, DB: db } as Env;
    expect(await getRotationSnapshot(env, "device-1")).toEqual(cached);
  });

  it("tolerates a snapshot cached by the pre-random deploy (sequential cursor, no history)", async () => {
    const kv = fakeKv();
    await kv.put(
      "rotation:device-1",
      JSON.stringify({ currentIndex: 1, lastReturned: "a", images: [image("a"), image("b")] })
    );
    const env = { KV: kv, DB: {} as Env["DB"] } as Env;

    const restored = await getRotationSnapshot(env, "device-1");
    expect(restored).toEqual({
      lastReturned: "a",
      lastBucketId: null,
      recentImageIds: [],
      images: [image("a"), image("b")],
    });
    expect(peekPendingImage("device-1", restored)).not.toBeNull();
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
                  ? { id: "img-z", filename: "z.bin", key_version: 1 }
                  : { id: "img-a", filename: "a.bin", key_version: 1 };
              return { results: [row] };
            }
            throw new Error(`unexpected all() query: ${sql}`);
          },
          first: async () => null, // no rotation_state row yet
        }),
      }),
    } as unknown as Env["DB"];
    const env = { KV: kv, DB: db } as Env;

    const restored = await getRotationSnapshot(env, "device-1");
    expect(restored.lastReturned).toBeNull();
    expect(restored.lastBucketId).toBeNull();
    expect(restored.recentImageIds).toEqual([]);
    expect(restored.images.map((i) => i.filename)).toEqual(["a.bin", "z.bin"]); // merged + re-sorted

    // Re-seeded into KV for next time.
    const cached = await kv.get<RotationSnapshot>("rotation:device-1", "json");
    expect(cached?.images.map((i) => i.filename)).toEqual(["a.bin", "z.bin"]);
  });

  it("restores the bucket and history from D1 so a cold cache still spaces picks out", async () => {
    const kv = fakeKv();
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("FROM device_buckets")) return { results: [{ bucket_id: "bucket-a" }] };
            return { results: [{ id: "img-a", filename: "a.bin", key_version: 1 }] };
          },
          first: async () => ({
            last_returned: "img-a",
            last_bucket_id: "bucket-a",
            recent_image_ids: '["img-a","img-b"]',
          }),
        }),
      }),
    } as unknown as Env["DB"];
    const env = { KV: kv, DB: db } as Env;

    const restored = await getRotationSnapshot(env, "device-1");
    expect(restored.lastBucketId).toBe("bucket-a");
    expect(restored.recentImageIds).toEqual(["img-a", "img-b"]);
  });

  it("treats a corrupt recent_image_ids blob as no history rather than failing the request", async () => {
    const kv = fakeKv();
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("FROM device_buckets")) return { results: [{ bucket_id: "bucket-a" }] };
            return { results: [{ id: "img-a", filename: "a.bin", key_version: 1 }] };
          },
          first: async () => ({ last_returned: null, last_bucket_id: null, recent_image_ids: "{not json" }),
        }),
      }),
    } as unknown as Env["DB"];
    const env = { KV: kv, DB: db } as Env;

    expect((await getRotationSnapshot(env, "device-1")).recentImageIds).toEqual([]);
  });
});
