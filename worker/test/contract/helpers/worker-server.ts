import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// helpers -> contract -> test -> worker
const WORKER_ROOT = path.resolve(__dirname, "..", "..", "..");
const WRANGLER_BIN = path.join(WORKER_ROOT, "node_modules", ".bin", "wrangler");

/** Fixed key seeded directly into D1 below so tests don't need to drive a passkey ceremony — never used outside this harness. */
export const TEST_API_KEY = "eink_contract_test_fixed_key_do_not_use_in_prod";

export interface WorkerServerHandle {
  baseUrl: string;
  apiKey: string;
  /** Runs raw SQL directly against this run's isolated local D1 — for seeding
   *  states the HTTP API can't produce (e.g. a legacy ownerless bucket row),
   *  so tests can prove access control fails closed regardless of how such a
   *  row might exist, not just that today's insert path avoids creating one. */
  execSql(sql: string): void;
  stop(): Promise<void>;
}

/**
 * Runs the real Worker via `wrangler dev` against an isolated local D1/KV
 * persistence directory (never the developer's regular `.wrangler/state`),
 * migrated fresh and seeded with one fixed-key test user per run.
 */
export async function startWorkerServer(port: number): Promise<WorkerServerHandle> {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "eink-worker-contract-"));

  execFileSync(
    WRANGLER_BIN,
    ["d1", "migrations", "apply", "eink-local", "--env", "local", "--local", "--persist-to", persistTo],
    { cwd: WORKER_ROOT, stdio: "pipe" }
  );

  const apiKeyHash = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");
  const userId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const sql = `INSERT INTO users (id, api_key_hash, created_at) VALUES ('${userId}', '${apiKeyHash}', ${now});`;
  execFileSync(
    WRANGLER_BIN,
    ["d1", "execute", "eink-local", "--env", "local", "--local", "--persist-to", persistTo, "--command", sql],
    { cwd: WORKER_ROOT, stdio: "pipe" }
  );

  // `detached: true` puts wrangler dev (and whatever it forks internally) in its
  // own process group so stop() can reliably kill the whole tree in one shot.
  const child = spawn(
    WRANGLER_BIN,
    ["dev", "--env", "local", "--port", String(port), "--persist-to", persistTo],
    {
      cwd: WORKER_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );

  let log = "";
  child.stdout?.on("data", (d) => (log += d.toString()));
  child.stderr?.on("data", (d) => (log += d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl, child, () => log);

  return {
    baseUrl,
    apiKey: TEST_API_KEY,
    execSql: (sql: string) => {
      execFileSync(
        WRANGLER_BIN,
        ["d1", "execute", "eink-local", "--env", "local", "--local", "--persist-to", persistTo, "--command", sql],
        { cwd: WORKER_ROOT, stdio: "pipe" }
      );
    },
    stop: async () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      await new Promise((resolve) => child.once("exit", resolve));
      fs.rmSync(persistTo, { recursive: true, force: true });
    },
  };
}

async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  getLog: () => string,
  timeoutMs = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (code ${child.exitCode}):\n${getLog()}`);
    }
    try {
      await fetch(`${baseUrl}/`);
      return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`wrangler dev did not become ready within ${timeoutMs}ms:\n${getLog()}`);
}
