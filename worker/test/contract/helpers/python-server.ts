import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// helpers -> contract -> test -> worker -> repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const FIXTURES_IMAGES_DIR = path.join(__dirname, "..", "fixtures", "images");

export interface PythonServerHandle {
  baseUrl: string;
  imagesDir: string;
  stop(): Promise<void>;
}

/**
 * Spawns the real image_server.py (the behavioral oracle) against isolated
 * fixture data via the env-var overrides added for this harness — never touches
 * the real images/ directory or .eink_rotation_state.json.
 */
export async function startPythonServer(port: number): Promise<PythonServerHandle> {
  const stateFile = path.join(os.tmpdir(), `eink-contract-state-${port}-${Date.now()}.json`);
  const globalConfig = path.join(os.tmpdir(), `eink-contract-global-${port}-${Date.now()}.json`);

  // `uv run` forks its own child process for the actual interpreter — killing just
  // the reported PID leaves that child orphaned. `detached: true` puts the whole
  // tree in its own process group so stop() can kill it in one shot.
  const child = spawn("uv", ["run", "python", "image_server.py"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      EINK_PORT: String(port),
      EINK_IMAGES_DIR: FIXTURES_IMAGES_DIR,
      EINK_STATE_FILE: stateFile,
      EINK_GLOBAL_CONFIG: globalConfig,
      EINK_DEBUG: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let log = "";
  child.stdout?.on("data", (d) => (log += d.toString()));
  child.stderr?.on("data", (d) => (log += d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl, child, () => log);

  return {
    baseUrl,
    imagesDir: FIXTURES_IMAGES_DIR,
    stop: async () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      await new Promise((resolve) => child.once("exit", resolve));
      for (const f of [stateFile, globalConfig]) {
        if (fs.existsSync(f)) fs.rmSync(f);
      }
    },
  };
}

async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  getLog: () => string,
  timeoutMs = 15000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Python server exited early (code ${child.exitCode}):\n${getLog()}`);
    }
    try {
      await fetch(`${baseUrl}/current`);
      return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Python server did not become ready within ${timeoutMs}ms:\n${getLog()}`);
}
