import type { Env } from "../types";
import { checkRateLimit } from "./rate-limit";

/**
 * Files (or dedupes onto) a GitHub issue for each device crash / OTA failure
 * that reaches POST /crash_report. Ported from epaper_clock's standalone
 * relay Worker (cloudflare-worker/src/index.js there) — here the device is
 * already HMAC-authenticated by /crash_report itself, so there's no separate
 * shared secret; this is just the GitHub half.
 *
 * Authenticates as a GitHub App installation (short-lived ~1h tokens, issues
 * attributed to a `<app>[bot]` identity) rather than a long-lived PAT. Fully
 * optional: with any of GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID /
 * GITHUB_APP_PRIVATE_KEY unset, reports are still stored in D1 and shown in
 * /admin, just never filed.
 *
 * The target repo is public, so issues never carry a device's MAC or owner —
 * only a short one-way hash of the MAC for "same device again?" correlation.
 */

const SIGNATURE_PREFIX = "device-failure-signature:";
const ISSUE_LABEL = "device-failure";
const USER_AGENT = "eink-worker";

/** Bounds total GitHub API use no matter how many devices are misbehaving. */
const GLOBAL_ISSUE_LIMIT = { limit: 20, windowSeconds: 3600 };
/** One device re-reporting the same failure (e.g. retrying a broken OTA every
 *  wake) only touches GitHub once per this window. */
const PER_DEVICE_SIGNATURE_TTL_SECONDS = 24 * 3600;

const INSTALLATION_TOKEN_KV_KEY = "github_app:installation_token";

export interface CrashIssueReport {
  mac: string;
  board: string | null;
  firmwareVersion: string;
  rolledBack: boolean;
  resetReason: string;
  bootAttempts: number;
  crashTask: string | null;
  crashPc: string | null;
  crashCause: number | null;
  backtrace: string[] | null;
  backtraceCorrupted: boolean | null;
  otaTargetVersion: string | null;
  otaError: string | null;
  batteryVoltage: string | null;
  receivedAt: number;
}

export function githubIssuesConfigured(env: Env): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY);
}

function issuesRepo(env: Env): string {
  return env.GITHUB_ISSUES_REPO || env.GITHUB_REPO;
}

type FailureKind = "ota_failure" | "rollback" | "crash";

function failureKind(r: CrashIssueReport): FailureKind {
  if (r.otaError) return "ota_failure";
  if (r.rolledBack) return "rollback";
  return "crash";
}

/**
 * A brownout with no core dump and no rollback is a power problem (weak
 * battery, marginal supply during the display refresh), not a firmware bug —
 * still stored and shown in /admin, just not worth an issue.
 */
export function shouldFileIssue(r: CrashIssueReport): boolean {
  return !(failureKind(r) === "crash" && r.resetReason === "brownout" && !r.crashPc);
}

/**
 * Stable key for "the same underlying failure" across devices — issues are
 * deduped on it. Deliberately excludes anything device-specific. The board is
 * included: an ee04-only crash at the same version is a different bug.
 */
export function failureSignature(r: CrashIssueReport): string {
  const board = r.board ?? "unknown";
  switch (failureKind(r)) {
    case "ota_failure":
      return `ota_failure:${board}:${r.otaTargetVersion ?? "?"}:${r.otaError}`;
    case "rollback":
      return `rollback:${board}:${r.firmwareVersion}`;
    case "crash":
      return `crash:${board}:${r.firmwareVersion}:${r.resetReason}:${r.crashPc ?? "no_pc"}`;
  }
}

export function issueTitle(r: CrashIssueReport): string {
  const board = r.board ?? "unknown board";
  switch (failureKind(r)) {
    case "ota_failure":
      return `OTA update failed: ${r.otaError} (${board}, ${r.firmwareVersion} -> ${r.otaTargetVersion ?? "?"})`;
    case "rollback":
      return `OTA rolled back: ${r.firmwareVersion} on ${board} (${r.resetReason})`;
    case "crash":
      return `Device crashed: ${r.resetReason}${r.crashPc ? " @ " + r.crashPc : ""} (${board}, ${r.firmwareVersion})`;
  }
}

/** Short, one-way device identifier safe for a public issue. */
export async function deviceTag(mac: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`eink-device:${mac}`));
  return Array.from(new Uint8Array(digest).slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function issueDetailsMarkdown(r: CrashIssueReport, device: string): string {
  const lines = [
    `**Kind:** ${failureKind(r)}`,
    `**Board:** ${r.board ?? "unknown"}`,
    `**Firmware version:** ${r.firmwareVersion}${r.rolledBack ? " (rolled back away from)" : ""}`,
  ];
  if (r.otaError) {
    lines.push(`**OTA target version:** ${r.otaTargetVersion ?? "?"}`);
    lines.push(`**OTA error:** \`${r.otaError}\``);
  }
  lines.push(`**Reset reason:** ${r.resetReason}`);
  if (r.rolledBack) lines.push(`**Unconfirmed boot attempts:** ${r.bootAttempts}`);
  if (r.crashTask || r.crashPc) {
    lines.push(`**Crashing task:** ${r.crashTask ?? "?"} @ \`${r.crashPc ?? "?"}\` (cause ${r.crashCause ?? "?"})`);
  }
  if (r.batteryVoltage) lines.push(`**Battery:** ${r.batteryVoltage} V`);
  lines.push(`**Device:** \`${device}\` (hashed MAC)`);
  lines.push(`**Received:** ${new Date(r.receivedAt * 1000).toISOString()}`);

  let md = lines.join("  \n");
  if (r.backtrace && r.backtrace.length) {
    md +=
      `\n\n**Backtrace**${r.backtraceCorrupted ? " (corrupted)" : ""} — symbolize with ` +
      "`xtensa-esp32s3-elf-addr2line -pfiaC -e firmware.elf <addrs>` against the matching release build:\n" +
      "```\n" + r.backtrace.join(" ") + "\n```";
  }
  return md;
}

// --- GitHub App authentication ---

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

/**
 * GITHUB_APP_PRIVATE_KEY must be PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----").
 * GitHub's "Generate a private key" button produces PKCS#1, which Web Crypto
 * can't import — convert once with
 * `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out pkcs8.pem`.
 */
async function createAppJwt(appId: string, privateKeyPkcs8Pem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s for clock drift; exp at GitHub's 10-minute max. This JWT
  // only ever authenticates the installation-token exchange below.
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(enc.encode(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, enc.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** Installation tokens live ~1h; cached in KV (for a bit less) so a burst of
 *  reports doesn't re-sign a JWT and re-exchange every time. */
async function getInstallationToken(env: Env): Promise<string> {
  const cached = await env.KV.get<{ token: string; expires_at: string }>(INSTALLATION_TOKEN_KV_KEY, "json");
  if (cached?.expires_at && Date.parse(cached.expires_at) - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }
  const jwt = await createAppJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!);
  const resp = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
    }
  );
  if (!resp.ok) {
    throw new Error(`installation token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { token: string; expires_at: string };
  await env.KV.put(INSTALLATION_TOKEN_KV_KEY, JSON.stringify(data), { expirationTtl: 50 * 60 });
  return data.token;
}

// --- Issue filing / dedup ---

/** Retries without the label if the repo rejects it (422), so a missing label
 *  never blocks the actual report. */
async function createIssue(repo: string, headers: HeadersInit, title: string, body: string) {
  const post = (withLabel: boolean) =>
    fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify(withLabel ? { title, body, labels: [ISSUE_LABEL] } : { title, body }),
    });
  let resp = await post(true);
  if (resp.status === 422) resp = await post(false);
  if (!resp.ok) throw new Error(`create issue failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as { number: number };
}

export type FileIssueResult =
  | { action: "skipped"; reason: "not_configured" | "not_issue_worthy" | "recently_reported" | "rate_limited" }
  | { action: "commented" | "created"; issueNumber: number };

/**
 * Files a new issue for this failure's signature, or comments on the open one
 * that already carries it. Meant to run inside waitUntil() after the report is
 * stored — errors are the caller's to log, never surfaced to the device.
 */
export async function fileCrashIssue(env: Env, r: CrashIssueReport): Promise<FileIssueResult> {
  if (!githubIssuesConfigured(env)) return { action: "skipped", reason: "not_configured" };
  if (!shouldFileIssue(r)) return { action: "skipped", reason: "not_issue_worthy" };

  const signature = failureSignature(r);
  const device = await deviceTag(r.mac);
  const seenKey = `github_issue_seen:${signature}:${device}`;
  if (await env.KV.get(seenKey)) return { action: "skipped", reason: "recently_reported" };
  if (!(await checkRateLimit(env, "gh-issue", "global", GLOBAL_ISSUE_LIMIT.limit, GLOBAL_ISSUE_LIMIT.windowSeconds))) {
    return { action: "skipped", reason: "rate_limited" };
  }

  const repo = issuesRepo(env);
  const token = await getInstallationToken(env);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
  const details = issueDetailsMarkdown(r, device);

  // Search is eventually consistent — a just-filed issue may not show up yet,
  // costing a duplicate issue at worst, never a lost report.
  const q = `repo:${repo} is:issue is:open in:body "${SIGNATURE_PREFIX}${signature}"`;
  const searchResp = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}`, { headers });
  const searchData = searchResp.ok ? ((await searchResp.json()) as { items?: { number: number }[] }) : { items: [] };

  let result: FileIssueResult;
  const existing = searchData.items?.[0];
  if (existing) {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: `Reported again:\n\n${details}` }),
    });
    if (!resp.ok) throw new Error(`comment failed: ${resp.status} ${await resp.text()}`);
    result = { action: "commented", issueNumber: existing.number };
  } else {
    const body =
      `${details}\n\n` +
      `<!-- ${SIGNATURE_PREFIX}${signature} -->\n` +
      `_Filed automatically by the Worker's POST /crash_report (worker/src/lib/github-issues.ts)._`;
    const created = await createIssue(repo, headers, issueTitle(r), body);
    result = { action: "created", issueNumber: created.number };
  }

  await env.KV.put(seenKey, "1", { expirationTtl: PER_DEVICE_SIGNATURE_TTL_SECONDS });
  return result;
}
