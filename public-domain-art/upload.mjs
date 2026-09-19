#!/usr/bin/env node
/**
 * Thin wrapper for uploading one or more artist folders from this directory
 * into encrypted image buckets. Reads each folder's manifest.json and takes
 * the bucket label from its "bucket" field (kept alongside the artist's
 * public-domain rationale — the manifest is the source of truth for both
 * what the images are and where they live), then hands off to
 * worker/scripts/upload-images.mjs, which does the real work (bucket
 * creation if needed, per-image skip-if-exists, the whole client-side
 * encrypt-and-pack pipeline — see that script's header).
 *
 * Usage (run from anywhere; folders are relative to this file):
 *   node upload.mjs                  # every artist folder
 *   node upload.mjs hokusai monet    # just these folders
 *   node upload.mjs hokusai --url https://... --api-key eink_... --dither atkinson
 *
 * The API key (and worker URL) come from --api-key/--url flags or the
 * EINK_API_KEY / EINK_WORKER_URL env vars, passed straight through to the
 * uploader. Any flag not listed here is forwarded too — so folders must
 * come first, before the first --flag (the first --flag ends the folder
 * list; its values, e.g. --bucket-key <val>, are forwarded untouched).
 */
import { readFile, readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uploader = path.join(here, "..", "worker", "scripts", "upload-images.mjs");

const argv = process.argv.slice(2);
const firstFlag = argv.findIndex((a) => a.startsWith("-"));
const folderArgs = firstFlag === -1 ? argv : argv.slice(0, firstFlag);
const passThrough = firstFlag === -1 ? [] : argv.slice(firstFlag);

let folders = folderArgs.map((f) => path.resolve(here, f));
if (folders.length === 0) {
  // No folders named: upload every artist folder that has a manifest.json.
  const entries = await readdir(here, { withFileTypes: true });
  folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(here, e.name))
    .filter((p) => existsSyncQuiet(path.join(p, "manifest.json")));
}
if (folders.length === 0) {
  console.error("No artist folders found (each needs a manifest.json).");
  process.exit(2);
}

function existsSyncQuiet(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

let failed = 0;
for (const folder of folders) {
  const name = path.basename(folder);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
  } catch (err) {
    console.error(`${name}: no readable manifest.json (${err.message}) — skipping`);
    failed++;
    continue;
  }
  if (!manifest.bucket) {
    console.error(`${name}: manifest has no "bucket" field — skipping (add one, e.g. the folder name)`);
    failed++;
    continue;
  }

  // Verify every manifest image exists before invoking the uploader, so a
  // typo'd filename fails loudly here instead of silently uploading the rest.
  const missing = manifest.images.filter((i) => !existsSyncQuiet(path.join(folder, i.filename)));
  if (missing.length > 0) {
    console.error(`${name}: manifest lists missing files: ${missing.map((m) => m.filename).join(", ")} — skipping`);
    failed++;
    continue;
  }

  const files = manifest.images.map((i) => path.join(folder, i.filename));
  console.log(`==> ${name}: uploading ${files.length} image(s) to bucket "${manifest.bucket}"`);
  const res = spawnSync(process.execPath, [uploader, "--bucket", manifest.bucket, ...passThrough, ...files], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(`==> ${name}: upload failed (exit ${res.status})`);
    failed++;
  }
}
if (failed > 0) {
  console.error(`${failed} folder(s) failed.`);
  process.exit(1);
}
