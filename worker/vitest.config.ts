import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // test/e2e/** runs separately via `npm run test:e2e` (vitest.e2e.config.ts) -
    // it spawns a real wrangler dev + the native firmware simulator, so it
    // doesn't belong in the fast default `npm test` run.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
