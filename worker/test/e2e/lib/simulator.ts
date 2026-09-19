import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// worker/test/e2e/lib/simulator.ts -> repo root/firmware/simulator
const SIMULATOR_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../firmware/simulator");

export type SimBoard = "ee02" | "ee04";

/** Builds (or rebuilds, if stale) the native simulator binary for one board -
 *  see firmware/simulator/README.md. macOS + SDL2 + PlatformIO's Arduino
 *  headers are NOT required here; this is the standalone Makefile build. */
export function buildSimulator(board: SimBoard = "ee02"): void {
  const result = spawnSync("make", [`BOARD=${board}`], { cwd: SIMULATOR_DIR, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `firmware/simulator build failed for BOARD=${board} (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
}

export interface SimRunOptions {
  board?: SimBoard;
  /** Base URL of the worker to hit - must be a local `wrangler dev`, never production. */
  server: string;
  /** Non-empty SSID skips config mode (see main_native.cpp's --wifi flag) -
   *  stubs/WiFi.h always reports WL_CONNECTED regardless of the value. */
  wifi?: string;
  /** Wipes this board's persisted state (.state/<board>/) before booting. */
  reset?: boolean;
  /** Overrides the test harness's default "always active" schedule pin
   *  (--active-start/--active-end). Leave undefined for the default pin;
   *  pass null to send NO active-window flags, so the device uses whatever
   *  schedule the server's /device_config provides (or its compiled-in
   *  default) — that's the path a real device's quiet-hours behavior takes. */
  activeWindow?: { start: number; end: number } | null;
  /** Runs exactly one boot cycle headlessly and saves the resulting display
   *  buffer as a numbered JPEG (see display_render.cpp). Always pass this in
   *  a test - without it the process runs forever, simulating repeated
   *  deep-sleep wake cycles until a window is closed. */
  exportPath: string;
}

export interface SimRunResult {
  stdout: string;
  claimUrl?: { mac: string; secret: string };
  /** Path(s) to the JPEG(s) DisplayRender wrote this run - normally exactly
   *  one, since one process invocation is one boot cycle. */
  exportedJpegPaths: string[];
}

/** Runs one full simulated boot cycle (wake -> WiFi -> fetch config -> fetch
 *  + display image -> deep sleep) and returns what happened. Throws if the
 *  process exits non-zero (a crash, not a normal "image fetch failed" log
 *  line - the firmware itself handles that gracefully and still exits 0). */
export function runSimulatorOnce(opts: SimRunOptions): SimRunResult {
  const board = opts.board ?? "ee02";
  const binary = path.join(SIMULATOR_DIR, `sim-${board}`);

  const args: string[] = ["--server", opts.server, "--export", opts.exportPath];
  if (opts.reset) args.push("--reset");
  if (opts.wifi) args.push("--wifi", opts.wifi);
  // Default to a pinned 24-hour active window: without this the suite's
  // outcome depends on the wall clock — the firmware's compiled-in default
  // (8-20 device-local, tz default UTC-6) makes any run before 8am local a
  // quiet-hours no-op ("skipping image fetch", no exported JPEG, test
  // fails). Tests that want to exercise the real server-driven schedule
  // path pass activeWindow: null to opt out of the pin. The schedule
  // override path itself is exercised by the quiet-hours test.
  if (opts.activeWindow !== null) {
    args.push("--active-start", "0", "--active-end", "23");
  }

  const result = spawnSync(binary, args, { cwd: SIMULATOR_DIR, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(
      `${binary} ${args.join(" ")} exited ${result.status}:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );
  }

  const stdout = result.stdout;
  const claimMatch = stdout.match(/claim=([0-9a-f]+)&secret=([0-9a-f]+)/i);
  const exportedJpegPaths = [...stdout.matchAll(/DisplayRender: saved (.+\.jpg)/g)].map((m) => m[1]!.trim());

  return {
    stdout,
    claimUrl: claimMatch ? { mac: claimMatch[1]!, secret: claimMatch[2]! } : undefined,
    exportedJpegPaths,
  };
}
