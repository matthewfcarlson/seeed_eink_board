import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts (which explicitly excludes test/e2e/**) -
// this suite builds the native firmware simulator and spins up a real
// wrangler dev instance, so it needs far longer timeouts and shouldn't run
// as part of the fast default `npm test`. Run explicitly with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // These spawn real child processes (wrangler dev, the sim binary) that
    // don't parallelize safely against each other on one port/persist dir.
    fileParallelism: false,
  },
});
