/**
 * CLI bulk-uploader for encrypted image buckets — the script-side twin of the
 * dashboard's confirmUpload() (src/client/admin.ts). Given a Worker URL and an
 * admin API key, it (1) creates the target bucket if it doesn't exist and
 * (2) uploads each image that isn't already in the bucket (matched by
 * filename), skipping the rest. See also scripts/upload-images.mjs, the
 * launcher that esbuild-bundles this file and runs it.
 *
 * The Worker only ever stores ciphertext, so this script must replicate the
 * browser's entire ingest pipeline (decode -> EXIF-correct -> crop -> rotate
 * -> enhance -> dither -> pack -> hash -> encrypt — see root CLAUDE.md's
 * encrypted-buckets plan). Dither/palette/packing/compression come from the
 * same src/lib+client modules the browser uses; only image decode/resize is
 * swapped from OffscreenCanvas to sharp, using the same cover-fit math as
 * client/decode.ts's decodeToUprightBuffer().
 *
 * Bucket key handling (a raw AES-256 key is needed to encrypt, and the Worker
 * can't hand one out):
 *   - New bucket: this script generates the key, ECIES-wraps it for the
 *     account's sharing_public_key (exposed on GET /admin/me) and creates the
 *     bucket — the dashboard's browser then unwraps it on next login, exactly
 *     like a bucket created in the browser.
 *   - Existing public bucket: the server surfaces public_key_raw (only when
 *     the caller has no personal wrap) — used automatically.
 *   - Existing private bucket: pass the raw key via --bucket-key (the `#key=`
 *     fragment from an invite link works; the script strips any prefix/URL).
 *
 * Usage:
 *   node scripts/upload-images.mjs --url https://... --api-key eink_... \
 *     --bucket "hokusai" [files-or-directories...] [--dither floyd_steinberg]
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  BOARD_GEOMETRY,
  BOARD_IDS,
  type BoardId,
  type DitherAlgorithm,
  DITHER_ALGORITHMS,
} from "../src/lib/media-constants";
import { computeHash16, ditherImage, enhance, packToNibbles } from "../src/lib/dither";
import { rotate90CW } from "../src/lib/decode";
import { compressPackedForUpload } from "../src/client/compress";
import {
  HKDF_INFO_BUCKET_WRAP,
  aesGcmEncryptBlob,
  importAesKeyRaw,
  wrapKeyFor,
} from "../src/client/crypto";

// Same browser-default enhance factors the dashboard's confirmUpload() uses
// (src/client/admin.ts's DEFAULT_BRIGHTNESS/CONTRAST/SATURATION).
const DEFAULT_BRIGHTNESS = 1.0;
const DEFAULT_CONTRAST = 1.2;
const DEFAULT_SATURATION = 1.2;

// src/client/thumbnail.ts's exact thumbnail geometry/quality.
const THUMBNAIL_WIDTH = 120;
const THUMBNAIL_HEIGHT = 160;
const THUMBNAIL_JPEG_QUALITY = 0.7;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);

// Mirrors lib/validate.ts's CONTROL_CHARS check — the filename is the
// UNIQUE(device_key, filename) catalog key and ends up in response headers.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// The script can't re-download a private bucket's raw key (the Worker only
// holds ECIES wraps for principals' public keys), so a key it generated or
// was told via --bucket-key is cached here, keyed by bucket id — the same
// trade the dashboard's IndexedDB keystore makes (worker/src/client/
// keystore.ts). Gitignored; deleting it just means supplying --bucket-key
// again. 600 mode keeps it out of other local users' reach.
const KEY_CACHE_PATH = join(fileURLToPath(new URL(".", import.meta.url)), ".bucket-keys.json");

async function readKeyCache(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(KEY_CACHE_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeKeyCache(bucketId: string, keyB64: string): Promise<void> {
  const cache = await readKeyCache();
  cache[bucketId] = keyB64;
  await writeFile(KEY_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
}

interface Options {
  url: string;
  apiKey: string;
  bucket: string;
  dither: DitherAlgorithm;
  bucketKeyB64: string | null;
  panX: number;
  panY: number;
  zoom: number;
  isPublic: boolean;
  allowUpscale: boolean;
  checkOnly: boolean;
  fit: "cover" | "contain";
  paths: string[];
}

function usage(): never {
  console.error(`Usage:
  node scripts/upload-images.mjs --url <worker-url> --api-key <eink_...> --bucket <label> \\
    <files-or-directories...> [--dither floyd_steinberg|atkinson|ordered]
    [--bucket-key <base64 32-byte key | invite #key= fragment | invite URL>]
    [--pan-x 0..1] [--pan-y 0..1] [--zoom >=1] [--public] [--allow-upscale]
    [--fit cover|contain]  — cover fills the canvas (crops edges, default);
      contain letterboxes the whole image onto a white canvas
    [--check-only <files-or-dirs>]  — just run the resolution gate, no upload

Env fallbacks: EINK_WORKER_URL, EINK_API_KEY.`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options & { paths: string[] } {
  const opts: Options & { paths: string[] } = {
    url: process.env.EINK_WORKER_URL ?? "",
    apiKey: process.env.EINK_API_KEY ?? "",
    bucket: "",
    dither: "floyd_steinberg",
    bucketKeyB64: null,
    panX: 0.5,
    panY: 0,
    zoom: 1,
    isPublic: false,
    allowUpscale: false,
    checkOnly: false,
    fit: "cover",
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v!;
    };
    switch (arg) {
      case "--url": opts.url = next(); break;
      case "--api-key": opts.apiKey = next(); break;
      case "--bucket": opts.bucket = next(); break;
      case "--dither": opts.dither = next() as DitherAlgorithm; break;
      case "--bucket-key": opts.bucketKeyB64 = next(); break;
      case "--pan-x": opts.panX = Number(next()); break;
      case "--pan-y": opts.panY = Number(next()); break;
      case "--zoom": opts.zoom = Number(next()); break;
      case "--public": opts.isPublic = true; break;
      case "--allow-upscale": opts.allowUpscale = true; break;
      case "--check-only": opts.checkOnly = true; break;
      case "--fit": {
        const v = next();
        if (v !== "cover" && v !== "contain") {
          console.error(`--fit must be "cover" or "contain" (got "${v}")`);
          process.exit(2);
        }
        opts.fit = v;
        break;
      }
      case "--help": case "-h": usage();
      default:
        if (arg.startsWith("--")) usage();
        opts.paths.push(arg);
    }
  }
  if (opts.paths.length === 0) usage();
  if (!opts.checkOnly && (!opts.url || !opts.apiKey || !opts.bucket)) usage();
  if (!DITHER_ALGORITHMS.includes(opts.dither)) {
    console.error(`--dither must be one of: ${DITHER_ALGORITHMS.join(", ")}`);
    process.exit(2);
  }
  opts.url = opts.url.replace(/\/+$/, "");
  // Center contain-fits vertically unless the caller says otherwise — the
  // cover default of panY=0 (top-align, keeps heads in portrait crops) would
  // pin a letterboxed landscape painting to the top of the screen.
  if (!argv.includes("--pan-y")) opts.panY = opts.fit === "contain" ? 0.5 : 0;
  return opts;
}

/** Accepts bare base64 (std or url-safe), a `#key=` fragment, or a full
 *  invite URL containing one — whatever's easiest to copy-paste. */
function decodeRawAesKeyB64(input: string): Uint8Array {
  const m = input.match(/[#&?]key=([^&\s]+)/);
  const b64 = (m ? m[1]! : input).trim();
  const decoded = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (decoded.length !== 32) {
    console.error("--bucket-key must decode to exactly 32 bytes of AES key (got " + decoded.length + ")");
    process.exit(2);
  }
  return new Uint8Array(decoded);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function api<T = unknown>(
  url: string,
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url + path, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // fall through — non-JSON error page
  }
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${typeof body === "object" && body && "error" in (body as object) ? (body as { error: string }).error : text.slice(0, 200)}`);
  }
  return body as T;
}

interface MeResponse {
  id: string;
  display_name: string | null;
  is_superuser: boolean;
  sharing_public_key: string | null;
}
interface BucketResponse {
  id: string;
  label: string;
  owner_id: string | null;
  key_version: number;
  is_owner: boolean;
  is_public: boolean;
  key: { ephemeralPub: string; nonce: string; ciphertext: string } | null;
  public_key_raw: string | null;
}

/** Resolves (or creates) the bucket and returns its raw AES-256 content key. */
async function resolveBucketAndKey(
  url: string,
  apiKey: string,
  opts: Options
): Promise<{ bucketId: string; key: Uint8Array }> {
  const me = await api<MeResponse>(url, apiKey, "/admin/me");
  console.log(`Authenticated as ${me.id}${me.is_superuser ? " (superuser)" : ""}`);

  const { buckets } = await api<{ buckets: BucketResponse[] }>(url, apiKey, "/admin/buckets");
  const existing = buckets.find((b) => b.label === opts.bucket);

  if (existing) {
    console.log(`Bucket "${existing.label}" exists (${existing.id}), key_version=${existing.key_version}`);
    if (existing.public_key_raw) {
      console.log("Using the bucket's server-held raw key (public bucket, no personal wrap).");
      const key = decodeRawAesKeyB64(existing.public_key_raw);
      await writeKeyCache(existing.id, toBase64(key));
      return { bucketId: existing.id, key };
    }
    if (opts.bucketKeyB64) {
      const key = decodeRawAesKeyB64(opts.bucketKeyB64);
      await writeKeyCache(existing.id, toBase64(key));
      return { bucketId: existing.id, key };
    }
    const cached = (await readKeyCache())[existing.id];
    if (cached) {
      console.log("Using this script's cached raw key for the bucket (scripts/.bucket-keys.json).");
      return { bucketId: existing.id, key: decodeRawAesKeyB64(cached) };
    }
    // A wrong key here doesn't fail until a device tries to decrypt — say so.
    console.error(
      `Private bucket without a supplied key: pass --bucket-key with the raw 32-byte key ` +
        `(e.g. the #key= fragment from this bucket's invite link). Without the real key the ` +
        `upload would be unreadable by every device, so refusing to guess.`
    );
    process.exit(2);
  }

  // Create it. The key must be wrapped for the OWNER's sharing public key or
  // no browser could ever unwrap it (the Worker stores wraps, never raw keys,
  // outside the public-bucket escape hatch).
  if (!me.sharing_public_key) {
    console.error(
      `This account has no sharing_public_key yet — log into the dashboard with your ` +
        `passkey once (that mints the keypair), then rerun.`
    );
    process.exit(2);
  }
  if (opts.isPublic && !me.is_superuser) {
    console.error("--public requires a superuser account (only a superuser may create a public bucket).");
    process.exit(2);
  }

  const key = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapKeyFor(Buffer.from(me.sharing_public_key, "base64"), key, HKDF_INFO_BUCKET_WRAP);
  const created = await api<{ id: string }>(url, apiKey, "/admin/buckets", {
    method: "POST",
    body: JSON.stringify({
      label: opts.bucket,
      key: wrapped,
      ...(opts.isPublic ? { is_public: true, public_key_raw: toBase64(key) } : {}),
    }),
    headers: { "Content-Type": "application/json" },
  });
  await writeKeyCache(created.id, toBase64(key));
  console.log(`Created bucket "${opts.bucket}" (${created.id})${opts.isPublic ? " [public]" : ""}`);
  return { bucketId: created.id, key };
}

async function listExistingFilenames(url: string, apiKey: string, bucketId: string): Promise<Set<string>> {
  const { images } = await api<{ images: Array<{ filename: string }> }>(
    url, apiKey, `/admin/images?device_key=${encodeURIComponent(bucketId)}`
  );
  return new Set(images.map((i) => i.filename));
}

async function expandPaths(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const entry of await readdir(p, { withFileTypes: true })) {
        if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push(join(p, entry.name));
        }
      }
    } else {
      files.push(p);
    }
  }
  files.sort();
  return files;
}

/**
 * sharp twin of client/decode.ts's decodeToUprightBuffer(): EXIF-correct,
 * fit to uprightW x uprightH with a crop window placed per CropParams
 * (panX/panY in [0,1], zoom >= 1). "cover" (the browser pipeline's only
 * mode) scales to fill and crops the overflow; "contain" scales to fit and
 * letterboxes the remainder in white — the whole work stays visible, at the
 * cost of white bands on whichever axis doesn't fill.
 */
async function decodeUpright(
  file: string,
  uprightW: number,
  uprightH: number,
  crop: { panX: number; panY: number; zoom: number },
  fit: "cover" | "contain"
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const img = sharp(file).rotate(); // no-arg rotate() = auto-orient from EXIF
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error(`${file}: cannot read image dimensions`);
  // EXIF orientations 5-8 are the 90°-transpose family — .rotate() swaps the
  // reported dimensions, so pick the *post-orientation* ones for cover math.
  const swap = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;

  const scale =
    (fit === "contain"
      ? Math.min(uprightW / width, uprightH / height)
      : Math.max(uprightW / width, uprightH / height)) * Math.max(1, crop.zoom);
  const scaledW = Math.round(width * scale);
  const scaledH = Math.round(height * scale);
  const clampedPanX = Math.min(1, Math.max(0, crop.panX));
  const clampedPanY = Math.min(1, Math.max(0, crop.panY));

  if (fit === "cover") {
    const x1 = Math.round((scaledW - uprightW) * clampedPanX);
    const y1 = Math.round((scaledH - uprightH) * clampedPanY);
    const { data, info } = await img
      .resize(scaledW, scaledH, { fit: "fill" })
      .extract({ left: x1, top: y1, width: uprightW, height: uprightH })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, info.width * info.height * 4),
      width: info.width,
      height: info.height,
    };
  }

  // contain: place the scaled image on the canvas per pan, crop if zoom
  // pushed it past the edge, then pad the remaining slack with white (the
  // dither palette maps 255 to the e-ink white nibble).
  const left = Math.round((uprightW - scaledW) * clampedPanX);
  const top = Math.round((uprightH - scaledH) * clampedPanY);
  const cropX = Math.max(0, -left);
  const cropY = Math.max(0, -top);
  const fittedW = Math.min(scaledW - cropX, uprightW);
  const fittedH = Math.min(scaledH - cropY, uprightH);
  const padL = Math.min(Math.round((uprightW - fittedW) * clampedPanX), uprightW - fittedW);
  const padT = Math.min(Math.round((uprightH - fittedH) * clampedPanY), uprightH - fittedH);
  const { data, info } = await img
    .resize(scaledW, scaledH, { fit: "fill" })
    .extract({ left: cropX, top: cropY, width: fittedW, height: fittedH })
    .extend({
      left: padL,
      top: padT,
      right: uprightW - fittedW - padL,
      bottom: uprightH - fittedH - padT,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, info.width * info.height * 4),
    width: info.width,
    height: info.height,
  };
}

/** sharp twin of client/thumbnail.ts's makeThumbnailJpeg(). */
async function makeThumbnailJpeg(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const jpeg = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "fill" })
    // Browser canvas takes 0-1; sharp takes 1-100.
    .jpeg({ quality: Math.round(THUMBNAIL_JPEG_QUALITY * 100) })
    .toBuffer();
  return new Uint8Array(jpeg);
}

/**
 * The whole per-image ingest for one source file: encrypt the raw original,
 * then for every board produce packed + thumbnail ciphertext exactly like
 * the dashboard's confirmUpload() (same modules, same order of operations).
 */
async function buildUploadForm(
  file: string,
  filename: string,
  key: Uint8Array,
  dither: DitherAlgorithm,
  crop: { panX: number; panY: number; zoom: number },
  fit: "cover" | "contain"
): Promise<FormData> {
  const aesKey = await importAesKeyRaw(key);
  const rawBytes = new Uint8Array(await readFile(file));
  const rawCiphertext = await aesGcmEncryptBlob(aesKey, rawBytes);

  const form = new FormData();
  form.set("dither_algorithm", dither);
  form.set("raw", new Blob([rawCiphertext]), "raw.bin");

  for (const board of BOARD_IDS) {
    const geometry = BOARD_GEOMETRY[board];
    const uprightW = geometry.needsRotation ? geometry.displayHeight : geometry.displayWidth;
    const uprightH = geometry.needsRotation ? geometry.displayWidth : geometry.displayHeight;

    const upright = await decodeUpright(file, uprightW, uprightH, crop, fit);
    // rotate90CW() copies, so enhance()ing the landscape copy leaves the
    // (pre-enhance) upright pristine for the thumbnail — same as the browser.
    const oriented = geometry.needsRotation
      ? rotate90CW(upright.rgba, upright.width, upright.height)
      : upright;
    enhance(oriented.rgba, oriented.width, oriented.height, DEFAULT_BRIGHTNESS, DEFAULT_CONTRAST, DEFAULT_SATURATION);

    const indices = ditherImage(oriented.rgba, oriented.width, oriented.height, dither);
    const packed = packToNibbles(indices);
    const thumbnail = await makeThumbnailJpeg(upright.rgba, upright.width, upright.height);

    // Compress the plaintext packed buffer BEFORE encrypting it — same rule
    // and same threshold as the browser (client/compress.ts).
    const { bytes: packedForUpload, encoding } = await compressPackedForUpload(packed);

    const [packedCiphertext, thumbCiphertext] = await Promise.all([
      aesGcmEncryptBlob(aesKey, packedForUpload),
      aesGcmEncryptBlob(aesKey, thumbnail),
    ]);
    const packedHash = await computeHash16(packedCiphertext);

    form.set(`packed_encoding__${board}`, encoding);
    form.set(`packed_hash__${board}`, packedHash);
    form.set(`packed__${board}`, new Blob([new Uint8Array(packedCiphertext)]), `packed-${board}.bin`);
    form.set(`thumb__${board}`, new Blob([new Uint8Array(thumbCiphertext)]), `thumb-${board}.bin`);
  }
  return form;
}

/**
 * Resolution gate: one source image feeds every board's packed variant, and
 * decodeUpright() cover-fits (never letterboxes) — a source smaller than a
 * board's upright canvas gets upscaled, which reads as blur on the display.
 * Fail fast listing offenders (per board, since a source can be fine for the
 * small board and too small for the big one) unless --allow-upscale.
 * Post-orientation dimensions, same swap rule as decodeUpright(). Cover needs
 * both dimensions at least as large as the canvas; contain only needs one
 * (it scales to the smaller ratio and letterboxes).
 */
async function checkResolution(files: string[], allowUpscale: boolean, fit: "cover" | "contain"): Promise<void> {
  if (files.length === 0) return;
  const problems: string[] = [];
  for (const file of files) {
    const meta = await sharp(file).metadata();
    if (!meta.width || !meta.height) throw new Error(`${file}: cannot read image dimensions`);
    const swap = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    for (const board of BOARD_IDS) {
      const g = BOARD_GEOMETRY[board];
      const uprightW = g.needsRotation ? g.displayHeight : g.displayWidth;
      const uprightH = g.needsRotation ? g.displayWidth : g.displayHeight;
      const fits =
        fit === "cover"
          ? width >= uprightW && height >= uprightH
          : width >= uprightW || height >= uprightH;
      if (!fits) {
        const scale =
          fit === "cover"
            ? Math.max(uprightW / width, uprightH / height)
            : Math.min(uprightW / width, uprightH / height);
        problems.push(
          `  ${basename(file)}: ${width}x${height} is smaller than ${board}'s ${uprightW}x${uprightH} canvas (would upscale x${scale.toFixed(2)})`
        );
      }
    }
  }
  if (problems.length === 0) return;
  console.error(
    `${problems.length} resolution problem(s) — sources smaller than a board's upright canvas get upscaled (soft on the display):\n` +
      problems.join("\n") +
      (allowUpscale ? "\n--allow-upscale set; continuing anyway." : "\nReplace the file(s) with higher-resolution versions, or pass --allow-upscale to upload anyway.")
  );
  if (!allowUpscale) process.exit(1);
}

function defaultFilename(path: string): string {
  const name = basename(path);
  if (!name || name.length > 255 || CONTROL_CHARS.test(name)) {
    throw new Error(`filename "${name}" is not a valid catalog filename (1-255 chars, no control characters)`);
  }
  return name;
}

export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.checkOnly) {
    const files = await expandPaths(opts.paths);
    await checkResolution(files, opts.allowUpscale, opts.fit);
    console.log(`${files.length} file(s): resolution check passed.`);
    return;
  }
  const { bucketId, key } = await resolveBucketAndKey(opts.url, opts.apiKey, opts);

  const existing = await listExistingFilenames(opts.url, opts.apiKey, bucketId);
  const files = await expandPaths(opts.paths);
  const pending = files.filter((f) => !existing.has(defaultFilename(f)));
  // Gate resolution only for files that will actually be uploaded — a
  // small source already in the bucket shouldn't block the rest.
  await checkResolution(pending, opts.allowUpscale, opts.fit);
  console.log(`${files.length} image file(s) found, ${existing.size} already in bucket.`);

  let uploaded = 0;
  let skipped = 0;
  for (const file of files) {
    const filename = defaultFilename(file);
    if (existing.has(filename)) {
      console.log(`  skip ${filename} (already in bucket)`);
      skipped++;
      continue;
    }
    process.stdout.write(`  upload ${filename} … `);
    try {
      const form = await buildUploadForm(file, filename, key, opts.dither, { panX: opts.panX, panY: opts.panY, zoom: opts.zoom }, opts.fit);
      await api(
        opts.url,
        opts.apiKey,
        `/admin/images/upload?device_key=${encodeURIComponent(bucketId)}&filename=${encodeURIComponent(filename)}`,
        { method: "POST", body: form }
      );
      console.log("ok");
      uploaded++;
    } catch (err) {
      console.log("FAILED");
      console.error(`    ${filename}: ${(err as Error).message}`);
    }
  }
  console.log(`Done: ${uploaded} uploaded, ${skipped} skipped.`);
  if (uploaded + skipped !== files.length) process.exitCode = 1;
}
