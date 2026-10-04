import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  failureSignature,
  fileCrashIssue,
  issueDetailsMarkdown,
  issueTitle,
  shouldFileIssue,
  type CrashIssueReport,
} from "../../src/lib/github-issues";
import type { Env } from "../../src/types";

const MAC = "AA:BB:CC:DD:EE:FF";

function report(overrides: Partial<CrashIssueReport> = {}): CrashIssueReport {
  return {
    mac: MAC,
    board: "ee02-13in3",
    firmwareVersion: "1.2.3",
    rolledBack: false,
    resetReason: "panic",
    bootAttempts: 0,
    crashTask: "loopTask",
    crashPc: "0x420182a0",
    crashCause: 28,
    backtrace: ["0x420182a0", "0x42001234"],
    backtraceCorrupted: false,
    otaTargetVersion: null,
    otaError: null,
    batteryVoltage: "3.91",
    receivedAt: 1_760_000_000,
    ...overrides,
  };
}

let privateKeyPem = "";
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
});

/** KV + D1 fakes covering just what fileCrashIssue touches (token cache,
 *  per-device seen keys, the global rate limiter's upsert). */
function makeEnv(configured = true) {
  const kv = new Map<string, string>();
  const rateRows = new Map<string, number>();
  const env = {
    GITHUB_REPO: "owner/repo",
    ...(configured
      ? { GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456", GITHUB_APP_PRIVATE_KEY: privateKeyPem }
      : {}),
    KV: {
      async get(key: string, type?: string) {
        const v = kv.get(key);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
    DB: {
      prepare() {
        let args: unknown[] = [];
        const bound = {
          bind(...a: unknown[]) {
            args = a;
            return bound;
          },
          async first() {
            const key = args[0] as string;
            rateRows.set(key, (rateRows.get(key) ?? 0) + 1);
            return { count: rateRows.get(key) };
          },
          async run() {
            return { meta: {} };
          },
        };
        return bound;
      },
    },
  } as unknown as Env;
  return { env, kv };
}

/** Fake api.github.com: records calls, serves search results from `openIssues`. */
function mockGitHub(openIssues: { number: number }[] = []) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/access_tokens")) {
      return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.includes("/search/issues")) return Response.json({ items: openIssues });
    if (url.endsWith("/comments")) return Response.json({ id: 1 }, { status: 201 });
    if (url.endsWith("/issues")) return Response.json({ number: 42 }, { status: 201 });
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("failure classification", () => {
  it("builds distinct signatures per failure kind, excluding anything device-specific", () => {
    expect(failureSignature(report())).toBe("crash:ee02-13in3:1.2.3:panic:0x420182a0");
    expect(failureSignature(report({ rolledBack: true }))).toBe("rollback:ee02-13in3:1.2.3");
    expect(failureSignature(report({ otaError: "sha256_mismatch", otaTargetVersion: "1.3.0" }))).toBe(
      "ota_failure:ee02-13in3:1.3.0:sha256_mismatch"
    );
    expect(failureSignature(report({ mac: "11:22:33:44:55:66" }))).toBe(failureSignature(report()));
  });

  it("skips a plain brownout, but not a brownout that rolled back or left a core dump", () => {
    expect(shouldFileIssue(report({ resetReason: "brownout", crashPc: null }))).toBe(false);
    expect(shouldFileIssue(report({ resetReason: "brownout", crashPc: null, rolledBack: true }))).toBe(true);
    expect(shouldFileIssue(report({ resetReason: "brownout" }))).toBe(true);
  });

  it("titles each kind", () => {
    expect(issueTitle(report())).toMatch(/^Device crashed: panic @ 0x420182a0/);
    expect(issueTitle(report({ rolledBack: true }))).toMatch(/^OTA rolled back: 1\.2\.3/);
    expect(issueTitle(report({ otaError: "http_404", otaTargetVersion: "1.3.0" }))).toMatch(
      /^OTA update failed: http_404 .*1\.2\.3 -> 1\.3\.0/
    );
  });

  it("never puts the raw MAC in the issue body", () => {
    const md = issueDetailsMarkdown(report(), "deadbeef");
    expect(md).not.toContain(MAC);
    expect(md).toContain("deadbeef");
    expect(md).toContain("0x420182a0 0x42001234");
  });
});

describe("fileCrashIssue", () => {
  it("does nothing when the GitHub App isn't configured", async () => {
    const calls = mockGitHub();
    const { env } = makeEnv(false);
    expect(await fileCrashIssue(env, report())).toEqual({ action: "skipped", reason: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("files a new labeled issue carrying the signature marker when none is open", async () => {
    const calls = mockGitHub([]);
    const { env } = makeEnv();
    expect(await fileCrashIssue(env, report())).toEqual({ action: "created", issueNumber: 42 });
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/owner/repo/issues"))!;
    expect(create.body.labels).toEqual(["device-failure"]);
    expect(create.body.body).toContain("<!-- device-failure-signature:crash:ee02-13in3:1.2.3:panic:0x420182a0 -->");
  });

  it("comments on the existing open issue for the same signature instead", async () => {
    const calls = mockGitHub([{ number: 7 }]);
    const { env } = makeEnv();
    expect(await fileCrashIssue(env, report())).toEqual({ action: "commented", issueNumber: 7 });
    expect(calls.some((c) => c.url.endsWith("/issues/7/comments"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues"))).toBe(false);
  });

  it("touches GitHub once per device+signature per day, and caches the installation token", async () => {
    const calls = mockGitHub([]);
    const { env } = makeEnv();
    await fileCrashIssue(env, report());
    expect(await fileCrashIssue(env, report())).toEqual({ action: "skipped", reason: "recently_reported" });
    // A different device with the same failure still gets through, reusing the token.
    await fileCrashIssue(env, report({ mac: "11:22:33:44:55:66" }));
    expect(calls.filter((c) => c.url.includes("/access_tokens"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/search/issues"))).toHaveLength(2);
  });
});
