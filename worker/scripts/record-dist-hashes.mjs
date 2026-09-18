// Code-integrity transparency log. Real deploys run via Cloudflare Workers
// Builds (git-connected: pushing to the connected branch triggers a build in
// an ephemeral Cloudflare-managed container, checked out fresh from that
// exact commit) — NOT a human running `wrangler deploy` locally. That matters
// for what "the record" actually is here:
//
//  - Cloudflare retains a build log per deployment, immutably tied to the
//    commit that triggered it — the developer can't quietly edit that after
//    the fact the way they could rewrite a local git file. So the primary
//    record is this script's own stdout during that build, which Cloudflare
//    keeps: printed below as one clearly-labeled, greppable line.
//  - Writing to dist-hashes.log still happens (kept for anyone doing a local/
//    manual `npm run deploy` — e.g. testing against a personal account) but
//    a write to it inside Workers Builds' ephemeral container is a no-op
//    that vanishes with the container: nothing commits it back to git. Don't
//    mistake its presence in a local working tree for a durable record of a
//    real Workers-Builds-driven deploy.
//  - public/static/build-info.json IS durable regardless of environment: it
//    ships as part of the deployed static assets, so the live site
//    self-reports its current commit/hashes at /static/build-info.json,
//    fetchable by anyone without needing this log or repo access at all.
//
// None of this PREVENTS a maliciously-modified deploy (see root CLAUDE.md's
// encrypted-buckets "Known gaps" — that needs a trust root outside this
// Worker's own control entirely, e.g. independently-verified reproducible
// builds or a browser extension pinning known-good hashes) — it makes one
// detectable/provable after the fact: a live bundle whose hash doesn't match
// what a clean checkout of its claimed commit rebuilds to is a contradiction
// anyone can catch by diffing against Cloudflare's retained build log for
// that deployment.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const commit = git(["rev-parse", "HEAD"]).slice(0, 12);
const dirty = git(["status", "--porcelain"]).length > 0;
const commitLabel = dirty ? `${commit}-dirty` : commit;
const recordedAt = new Date().toISOString();

const files = {
  "admin.js": sha256(path.join(root, "public/static/admin.js")),
  "provision.js": sha256(path.join(root, "public/static/provision.js")),
};

const hashFields = Object.entries(files)
  .map(([name, hash]) => `${name}=sha256:${hash}`)
  .join(" ");

// The line that matters: printed unconditionally so it lands in Cloudflare's
// retained build log for this deployment, whether or not anyone ever commits
// dist-hashes.log. Keep this format stable — it's meant to be grepped out of
// a build log later, not just read by a human at deploy time.
console.log(`INTEGRITY-RECORD recorded_at=${recordedAt} commit=${commitLabel} ${hashFields}`);

appendFileSync(path.join(root, "dist-hashes.log"), `${recordedAt} commit=${commitLabel} ${hashFields}\n`);

writeFileSync(
  path.join(root, "public/static/build-info.json"),
  JSON.stringify({ commit: commitLabel, recorded_at: recordedAt, files }, null, 2) + "\n"
);

if (dirty) {
  console.warn(
    "WARNING: working tree has uncommitted changes — this build's bundles can't be reproduced " +
    "from any single git commit. Workers Builds always checks out clean, so seeing this there " +
    "means something (a build-step side effect?) modified the tree after checkout — investigate."
  );
}
if (!process.env.CI) {
  console.log(
    "Reminder: this ran locally, not in Workers Builds — dist-hashes.log only became part of " +
    "the public record if you commit and push it. A real deploy's record of truth is Cloudflare's " +
    "own build log for that deployment."
  );
}
