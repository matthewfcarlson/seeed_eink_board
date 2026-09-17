import { describe, expect, it } from "vitest";
import { verifyDeviceSignature } from "../../src/lib/device-signature";
import type { Env } from "../../src/types";

const SECRET_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

async function hmacHex(secretHex: string, message: string): Promise<string> {
  const bytes = new Uint8Array(secretHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(secretHex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sign(mac: string, path: string, nonce: number): Promise<string> {
  return hmacHex(SECRET_HEX, `${mac}|${path}|${nonce}`);
}

/** Fake D1 tracking `last_nonce` for one device row, mutated by the module's own UPDATE. */
function fakeDb(initialLastNonce: number | null): { db: Env["DB"]; getLastNonce: () => number | null } {
  let lastNonce = initialLastNonce;
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          if (sql.includes("SELECT last_nonce")) {
            return lastNonce === null ? null : ({ last_nonce: lastNonce } as unknown as T);
          }
          throw new Error(`fakeDb: unrecognized first() query: ${sql}`);
        },
        run: async () => {
          if (sql.includes("UPDATE devices")) {
            const [nonce, , maxNonce] = args as [number, string, number];
            if (lastNonce === null || lastNonce <= maxNonce) lastNonce = nonce;
            return {};
          }
          throw new Error(`fakeDb: unrecognized run() query: ${sql}`);
        },
      }),
    }),
  } as unknown as Env["DB"];
  return { db, getLastNonce: () => lastNonce };
}

describe("verifyDeviceSignature", () => {
  it("accepts a correctly-signed request with no prior nonce on file", async () => {
    const { db } = fakeDb(null);
    const env = { DB: db } as Env;
    const signature = await sign("aabbccddeeff", "/image_packed", 1);
    expect(await verifyDeviceSignature(env, "aabbccddeeff", SECRET_HEX, "/image_packed", "1", signature)).toBe(true);
  });

  it("rejects a missing nonce or signature header", async () => {
    const { db } = fakeDb(null);
    const env = { DB: db } as Env;
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", undefined, "deadbeef")).toBe(false);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "1", undefined)).toBe(false);
  });

  it("rejects a non-numeric or non-positive nonce", async () => {
    const { db } = fakeDb(null);
    const env = { DB: db } as Env;
    const signature = await sign("mac", "/hash", 1);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "not-a-number", signature)).toBe(false);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "0", signature)).toBe(false);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "-5", signature)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const { db } = fakeDb(null);
    const env = { DB: db } as Env;
    const wrongSignature = await sign("mac", "/hash", 1); // not signed with SECRET_HEX in the assertion below
    const bogusSecret = "00".repeat(32);
    const realSignature = await hmacHex(bogusSecret, "mac|/hash|1");
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "1", realSignature)).toBe(false);
    expect(wrongSignature).not.toBe(realSignature);
  });

  it("rejects a signature computed for a different path (can't replay /hash's signature against /image_packed)", async () => {
    const { db } = fakeDb(null);
    const env = { DB: db } as Env;
    const signatureForHash = await sign("mac", "/hash", 1);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/image_packed", "1", signatureForHash)).toBe(false);
  });

  it("is case-insensitive on the hex signature", async () => {
    const { db } = fakeDb(null);
    const env = { DB: db } as Env;
    const signature = await sign("mac", "/hash", 1);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "1", signature.toUpperCase())).toBe(true);
  });

  it("rejects a nonce lower than the last one seen (replay of a stale request)", async () => {
    const { db } = fakeDb(10);
    const env = { DB: db } as Env;
    const signature = await sign("mac", "/hash", 5);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "5", signature)).toBe(false);
  });

  it("accepts a strictly increasing nonce and advances last_nonce", async () => {
    const { db, getLastNonce } = fakeDb(10);
    const env = { DB: db } as Env;
    const signature = await sign("mac", "/hash", 11);
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "11", signature)).toBe(true);
    expect(getLastNonce()).toBe(11);
  });

  it("KNOWN GAP: a captured (nonce, signature) pair can be replayed indefinitely as long as the nonce doesn't decrease — only a *decreasing* nonce is rejected, not a *repeated* one", async () => {
    const { db } = fakeDb(null);
    const env = { DB: db } as Env;
    const signature = await sign("mac", "/hash", 7);
    // First use: accepted, last_nonce becomes 7.
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "7", signature)).toBe(true);
    // Same exact (nonce, signature) replayed again: still accepted, since
    // verifyDeviceSignature only checks `nonce < last_nonce`, never `nonce <= last_nonce`.
    expect(await verifyDeviceSignature(env, "mac", SECRET_HEX, "/hash", "7", signature)).toBe(true);
  });
});
