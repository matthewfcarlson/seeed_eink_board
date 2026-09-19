#!/usr/bin/env node
/**
 * Launcher for scripts/upload-images.ts — esbuild-bundles it (pulling in the
 * same src/lib+client image-pipeline modules the browser uses; only sharp is
 * external since it's a native module) and runs the result. This exists so
 * the repo needs no TS runtime dependency: plain `node` plus the esbuild
 * devDependency already present for build-client.mjs.
 *
 *   node scripts/upload-images.mjs --url https://… --api-key eink_… --bucket hokusai ./public-domain-art/hokusai
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Bundled next to this script (not a tmpdir) so the external "sharp" import
// resolves against the repo's node_modules.
const outfile = path.join(here, ".upload-images.bundle.mjs");

try {
  await build({
    entryPoints: [path.join(here, "upload-images.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    // sharp is native — keep it external so it loads from node_modules.
    external: ["sharp"],
    outfile,
    logLevel: "warning",
  });
  const { main } = await import(pathToFileURL(outfile).href);
  await main(process.argv.slice(2));
} finally {
  await rm(outfile, { force: true }).catch(() => {});
}
