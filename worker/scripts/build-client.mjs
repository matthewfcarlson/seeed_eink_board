import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");

await build({
  entryPoints: [
    path.join(root, "src/client/admin.ts"),
    path.join(root, "src/client/provision.ts"),
  ],
  outdir: path.join(root, "public/static"),
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: process.env.NODE_ENV === "production",
  logLevel: "info",
});
