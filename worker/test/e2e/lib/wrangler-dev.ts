import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// worker/test/e2e/lib/wrangler-dev.ts -> worker/
const WORKER_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const WRANGLER_BIN = path.join(WORKER_DIR, "node_modules/.bin/wrangler");

export interface WranglerDevHandle {
  baseUrl: string;
  // This instance's throwaway --persist-to directory - exposed so a test can
  // run its own `wrangler d1 execute ... --persist-to <this>` against the
  // exact same local D1 the running `wrangler dev` is using (e.g. to grant
  // is_superuser the same way root CLAUDE.md's public-buckets plan documents
  // for a real deployment, just pointed at this throwaway DB instead of
  // "eink-local"'s normal default persistence directory).
  persistDir: string;
  stop(): Promise<void>;
}

/**
 * Spins up a throwaway `wrangler dev --env local` instance for this suite -
 * never production (see firmware/simulator/README.md's own rule for the
 * simulator, same reasoning here). Uses its own `--persist-to` temp
 * directory rather than the project's default `.wrangler/state`, so this
 * never collides with (or leaves test buckets/devices in) whatever local D1
 * data a developer's own `npm run dev` session already has - including a
 * concurrently-running one, since two `wrangler dev` processes sharing one
 * persistence directory would fight over the same SQLite files.
 */
export async function startWranglerDev(opts: { port?: number; readyTimeoutMs?: number } = {}): Promise<WranglerDevHandle> {
  const port = opts.port ?? 8788;
  const baseUrl = `http://localhost:${port}`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const persistDir = mkdtempSync(path.join(tmpdir(), "eink-e2e-wrangler-"));

  const migrate = spawnSync(
    WRANGLER_BIN,
    ["d1", "migrations", "apply", "eink-local", "--local", "--env", "local", "--persist-to", persistDir],
    { cwd: WORKER_DIR, encoding: "utf8" }
  );
  if (migrate.status !== 0) {
    throw new Error(`D1 migration failed (exit ${migrate.status}):\n${migrate.stdout}\n${migrate.stderr}`);
  }

  const buildClient = spawnSync("node", ["scripts/build-client.mjs"], { cwd: WORKER_DIR, encoding: "utf8" });
  if (buildClient.status !== 0) {
    throw new Error(`build:client failed (exit ${buildClient.status}):\n${buildClient.stdout}\n${buildClient.stderr}`);
  }

  const child = spawn(
    WRANGLER_BIN,
    ["dev", "--env", "local", "--port", String(port), "--persist-to", persistDir],
    { cwd: WORKER_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  let exited = false;
  child.once("exit", () => (exited = true));

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`wrangler dev exited before becoming ready:\n${output}`);
    try {
      await fetch(baseUrl);
      return { baseUrl, persistDir, stop: () => stopWranglerDev(child, persistDir) };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await stopWranglerDev(child, persistDir);
  throw new Error(`wrangler dev did not become ready within ${readyTimeoutMs}ms on ${baseUrl}:\n${output}`);
}

/**
 * Grants is_superuser to a specific user id against this handle's own local
 * D1 - the exact same `wrangler d1 execute ... --command "UPDATE users SET
 * is_superuser = 1 WHERE id = ..."` documented in migrations/
 * 0018_public_buckets.sql for a real deployment, just against this
 * throwaway --persist-to directory instead of a developer's normal local DB
 * or the real remote one. There is deliberately no API for this (see that
 * migration's comment) - a real operator runs this by hand, so an e2e test
 * covering the public-buckets feature has to do the same thing.
 */
export function grantSuperuser(handle: WranglerDevHandle, userId: string): void {
  const result = spawnSync(
    WRANGLER_BIN,
    [
      "d1",
      "execute",
      "eink-local",
      "--local",
      "--env",
      "local",
      "--persist-to",
      handle.persistDir,
      "--command",
      `UPDATE users SET is_superuser = 1 WHERE id = '${userId}';`,
    ],
    { cwd: WORKER_DIR, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to grant is_superuser to ${userId} (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

async function stopWranglerDev(child: ReturnType<typeof spawn>, persistDir: string): Promise<void> {
  if (child.pid && child.exitCode === null) {
    try {
      // Negative pid targets the whole detached process group - wrangler dev
      // spawns its own runtime subprocess that a plain child.kill() would leave behind.
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 5000);
    });
  }
  rmSync(persistDir, { recursive: true, force: true });
}
