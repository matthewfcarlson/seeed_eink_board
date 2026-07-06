import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Both contract-suite backends bind fixed local ports and spin up real
    // subprocesses (Flask, wrangler dev) — running test files in parallel would
    // just fight over ports/state for no speed benefit at this suite's size.
    fileParallelism: false,
  },
});
