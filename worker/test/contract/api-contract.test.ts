import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPythonServer, type PythonServerHandle } from "./helpers/python-server";
import { startWorkerServer, type WorkerServerHandle } from "./helpers/worker-server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_IMAGES_DIR = path.join(__dirname, "fixtures", "images");
const SCHEDULE_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "device_configs", "aabbccddeeff.json"), "utf-8")
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = (res: Response): Promise<any> => res.json();

const DEVICE_MAC = "aabbccddeeff";
// Only exercised against the Worker (lib/device-signature.ts) — Python has no such
// concept and ignores these headers entirely, so it's safe to always send them.
const DEVICE_SECRET = "aabbccddeeff00112233445566778899";
const PYTHON_PORT = 8899;
const WORKER_PORT = 8898;

// Mirrors the firmware's NVS-persisted counter (ConfigManager::nextNonce()), not
// a timestamp — a monotonically increasing integer is all lib/device-signature.ts
// requires, and a real counter avoids any ambiguity from clock-based nonces.
let testNonceCounter = 0;

/** Builds the X-Device-Nonce/X-Device-Signature headers lib/device-signature.ts
 *  requires for a registered device's requests, alongside X-Device-MAC. */
function signedHeaders(requestPath: string): Record<string, string> {
  const nonce = ++testNonceCounter;
  const signature = crypto
    .createHmac("sha256", Buffer.from(DEVICE_SECRET, "hex"))
    .update(`${DEVICE_MAC}|${requestPath}|${nonce}`)
    .digest("hex");
  return {
    "X-Device-MAC": DEVICE_MAC,
    "X-Device-Nonce": String(nonce),
    "X-Device-Signature": signature,
  };
}

let python: PythonServerHandle;
let worker: WorkerServerHandle;

// `bucketId` is the worker-side bucket the bytes land in (an opaque id for a
// freshly created bucket); `fixtureDir` is just where the source file lives on
// disk — the two are unrelated since bucket ids are no longer the device's own
// mac (see migrations/0007_buckets.sql).
async function uploadToWorker(bucketId: string, fixtureDir: string, filename: string): Promise<void> {
  const bytes = fs.readFileSync(path.join(FIXTURES_IMAGES_DIR, fixtureDir, filename));
  const res = await fetch(
    `${worker.baseUrl}/admin/images/upload?device_key=${bucketId}&filename=${filename}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "image/jpeg" },
      body: bytes,
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to seed ${fixtureDir}/${filename} on worker: ${res.status} ${await res.text()}`);
  }
}

beforeAll(async () => {
  [python, worker] = await Promise.all([startPythonServer(PYTHON_PORT), startWorkerServer(WORKER_PORT)]);

  // Same schedule fixture, two representations: a device_config.json file for
  // Python's filesystem-based fallback chain, and a PUT for the Worker's D1 row.
  fs.writeFileSync(
    path.join(FIXTURES_IMAGES_DIR, DEVICE_MAC, "device_config.json"),
    JSON.stringify(SCHEDULE_FIXTURE, null, 2)
  );

  await fetch(`${worker.baseUrl}/admin/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mac: DEVICE_MAC, label: "Contract test device", secret: DEVICE_SECRET }),
  });

  // Buckets are independent, shareable entities a device explicitly subscribes
  // to (migrations/0007_buckets.sql) — nothing is auto-subscribed for a newly
  // registered device, unlike the old include_default_images-on-by-default
  // column. Create this device's own bucket and subscribe it, leaving the
  // 'default'-named bucket below un-subscribed so Python's fallback-only
  // rotation (device dir if present, else images/default/, never both) stays
  // directly comparable. There's no more globally-shared 'default' bucket id on
  // the Worker side (migrations/0009_bucket_ownership.sql) — this is just an
  // ordinary bucket the test's own admin user owns, matching Python's
  // images/default/ fixture dir by content, not by id.
  const createBucketRes = await fetch(`${worker.baseUrl}/admin/buckets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Contract test device bucket" }),
  });
  const { id: deviceBucketId } = (await createBucketRes.json()) as { id: string };

  const createDefaultBucketRes = await fetch(`${worker.baseUrl}/admin/buckets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Contract test default-equivalent bucket" }),
  });
  const { id: defaultBucketId } = (await createDefaultBucketRes.json()) as { id: string };

  await fetch(`${worker.baseUrl}/admin/devices/${DEVICE_MAC}/buckets`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bucket_ids: [deviceBucketId] }),
  });

  await fetch(`${worker.baseUrl}/admin/schedule/${DEVICE_MAC}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(SCHEDULE_FIXTURE),
  });

  // Rotation order is alphabetical-by-filename on both backends, so uploading
  // under the same filenames keeps peek/advance sequencing directly comparable.
  await uploadToWorker(defaultBucketId, "default", "alpha.jpg");
  await uploadToWorker(defaultBucketId, "default", "beta.jpg");
  await uploadToWorker(deviceBucketId, DEVICE_MAC, "one.jpg");
  await uploadToWorker(deviceBucketId, DEVICE_MAC, "two.jpg");
}, 60000);

afterAll(async () => {
  const configFile = path.join(FIXTURES_IMAGES_DIR, DEVICE_MAC, "device_config.json");
  if (fs.existsSync(configFile)) fs.rmSync(configFile);
  await Promise.all([python?.stop(), worker?.stop()]);
});

describe("GET /device_config", () => {
  it("returns identical schedule values on both backends (pure config passthrough)", async () => {
    const headers = signedHeaders("/device_config");
    const [pyRes, workerRes] = await Promise.all([
      fetch(`${python.baseUrl}/device_config`, { headers }),
      fetch(`${worker.baseUrl}/device_config`, { headers }),
    ]);
    expect(pyRes.status).toBe(200);
    expect(workerRes.status).toBe(200);

    const [pyBody, workerBody] = await Promise.all([asJson(pyRes), asJson(workerRes)]);

    for (const key of Object.keys(SCHEDULE_FIXTURE)) {
      expect(pyBody[key], `python ${key}`).toBe(SCHEDULE_FIXTURE[key]);
      expect(workerBody[key], `worker ${key}`).toBe(SCHEDULE_FIXTURE[key]);
    }

    const nowSeconds = Date.now() / 1000;
    expect(Math.abs(pyBody.server_time_epoch - nowSeconds)).toBeLessThan(10);
    expect(Math.abs(workerBody.server_time_epoch - nowSeconds)).toBeLessThan(10);
  });

  it("omits schedule fields entirely (not null) when no override exists", async () => {
    const [pyRes, workerRes] = await Promise.all([
      fetch(`${python.baseUrl}/device_config`, { headers: { "X-Device-MAC": "unregistered000000" } }),
      fetch(`${worker.baseUrl}/device_config`, { headers: { "X-Device-MAC": "unregistered000000" } }),
    ]);
    const [pyBody, workerBody] = await Promise.all([asJson(pyRes), asJson(workerRes)]);
    for (const key of Object.keys(SCHEDULE_FIXTURE)) {
      expect(key in pyBody, `python should omit ${key}`).toBe(false);
      expect(key in workerBody, `worker should omit ${key}`).toBe(false);
    }
  });
});

describe.each([
  ["python", () => python],
  ["worker", () => worker],
] as const)("GET /hash and /image_packed on %s", (_name, getServer) => {
  it("hash is a stable 16-char plain-text value until image_packed advances rotation", async () => {
    const server = getServer();

    // Content-Type is intentionally not asserted here: firmware's checkImageChanged()
    // only requires status 200 and a 16-char body (http.getString() ignores the
    // declared type) — Python's Flask defaults plain-string returns to text/html,
    // the Worker returns text/plain; both satisfy the actual firmware contract.
    const hash1Res = await fetch(`${server.baseUrl}/hash`, { headers: signedHeaders("/hash") });
    expect(hash1Res.status).toBe(200);
    const hash1 = await hash1Res.text();
    expect(hash1).toHaveLength(16);

    // Calling /hash again must not advance rotation.
    const hash1Again = await (
      await fetch(`${server.baseUrl}/hash`, { headers: signedHeaders("/hash") })
    ).text();
    expect(hash1Again).toBe(hash1);

    // /image_packed must serve the exact same pending image /hash described.
    const packedRes = await fetch(`${server.baseUrl}/image_packed`, { headers: signedHeaders("/image_packed") });
    expect(packedRes.status).toBe(200);
    const body = new Uint8Array(await packedRes.arrayBuffer());
    expect(body.byteLength).toBe(960000);
    expect(packedRes.headers.get("content-length")).toBe(String(body.byteLength));
    const returnedHash = packedRes.headers.get("x-image-hash");
    expect(returnedHash).toHaveLength(16);
    expect(returnedHash).toBe(hash1);

    // Now rotation must have advanced: /hash reflects the next image (2 images in this bucket).
    const hash2 = await (await fetch(`${server.baseUrl}/hash`, { headers: signedHeaders("/hash") })).text();
    expect(hash2).not.toBe(hash1);
    expect(hash2).toHaveLength(16);

    const packed2Res = await fetch(`${server.baseUrl}/image_packed`, { headers: signedHeaders("/image_packed") });
    const returnedHash2 = packed2Res.headers.get("x-image-hash");
    expect(returnedHash2).toBe(hash2);

    // With exactly 2 images, a third fetch wraps back around to the first image.
    const hash3 = await (await fetch(`${server.baseUrl}/hash`, { headers: signedHeaders("/hash") })).text();
    expect(hash3).toBe(hash1);
  });

  it("image_packed's ?known_hash= folds the /hash pre-check into one request", async () => {
    const server = getServer();

    // Picks up wherever the previous test left rotation (pending image = hash1,
    // per that test's final assertion) - /hash doesn't advance, so this is stable.
    const currentHash = await (await fetch(`${server.baseUrl}/hash`, { headers: signedHeaders("/hash") })).text();
    expect(currentHash).toHaveLength(16);

    // Matching known_hash -> 304, no body, and rotation must NOT advance.
    const unchangedRes = await fetch(`${server.baseUrl}/image_packed?known_hash=${currentHash}`, {
      headers: signedHeaders("/image_packed"),
    });
    expect(unchangedRes.status).toBe(304);
    expect((await unchangedRes.arrayBuffer()).byteLength).toBe(0);

    const hashAfterUnchanged = await (
      await fetch(`${server.baseUrl}/hash`, { headers: signedHeaders("/hash") })
    ).text();
    expect(hashAfterUnchanged).toBe(currentHash);

    // A stale/wrong known_hash -> normal 200 + full image, and rotation advances
    // exactly like calling /image_packed with no known_hash at all.
    const changedRes = await fetch(`${server.baseUrl}/image_packed?known_hash=0000000000000000`, {
      headers: signedHeaders("/image_packed"),
    });
    expect(changedRes.status).toBe(200);
    const body = new Uint8Array(await changedRes.arrayBuffer());
    expect(body.byteLength).toBe(960000);
    expect(changedRes.headers.get("x-image-hash")).toBe(currentHash);

    const hashAfterChanged = await (
      await fetch(`${server.baseUrl}/hash`, { headers: signedHeaders("/hash") })
    ).text();
    expect(hashAfterChanged).not.toBe(currentHash);
  });
});

describe("GET /current", () => {
  it("reports the same total image count and device identity on both backends", async () => {
    const [pyRes, workerRes] = await Promise.all([
      fetch(`${python.baseUrl}/current?device=${DEVICE_MAC}`),
      fetch(`${worker.baseUrl}/current?device=${DEVICE_MAC}`, {
        headers: { Authorization: `Bearer ${worker.apiKey}` },
      }),
    ]);
    expect(pyRes.status).toBe(200);
    expect(workerRes.status).toBe(200);

    const pyBody = await asJson(pyRes);
    const workerBody = await asJson(workerRes);

    expect(pyBody.device_id).toBe(DEVICE_MAC);
    expect(workerBody.device_id).toBe(DEVICE_MAC);
    // Python nests rotation status; the Worker exposes it flat — semantic
    // equivalence, not byte-identical shape (see plan §Test harness).
    expect(pyBody.rotation.total_images).toBe(2);
    expect(workerBody.total_images).toBe(2);
  });

  // Worker-only: the Python reference server (image_server.py) is a single-tenant
  // local tool with no concept of users, so this endpoint has no auth there.
  // The Worker is multi-tenant — see privacy review, 2026-07-07 — so it must
  // require a login and never hand back another user's device status.
  it("requires auth and never leaks another user's devices (worker only)", async () => {
    const noAuthRes = await fetch(`${worker.baseUrl}/current`);
    expect(noAuthRes.status).toBe(401);

    const noAuthWithDeviceRes = await fetch(`${worker.baseUrl}/current?device=${DEVICE_MAC}`);
    expect(noAuthWithDeviceRes.status).toBe(401);
  });
});

describe("Bucket content requires device identification (worker only)", () => {
  // Regression coverage for the privacy fix in migrations/0009_bucket_ownership.sql:
  // omitting X-Device-MAC entirely used to silently serve the shared 'default'
  // bucket's real images with zero authentication.
  it("/image_packed and /hash reject requests with no X-Device-MAC header", async () => {
    const [packedRes, hashRes] = await Promise.all([
      fetch(`${worker.baseUrl}/image_packed`),
      fetch(`${worker.baseUrl}/hash`),
    ]);
    expect(packedRes.status).toBe(400);
    expect(hashRes.status).toBe(400);
  });
});

describe("The 'default' bucket can never be recreated as a shared/ownerless bucket (worker only)", () => {
  // POST /admin/buckets's request body only ever reads `label` (routes/admin/buckets.ts)
  // — id is always crypto.randomUUID(), server-side, never client input. Proves that
  // holds even when a caller actively tries to force the reserved id.
  it("ignores a client-supplied id, including an attempt to claim 'default'", async () => {
    const res = await fetch(`${worker.baseUrl}/admin/buckets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "default", label: "Attempted default bucket" }),
    });
    expect(res.status).toBe(201);
    const body = await asJson(res);
    expect(body.id).not.toBe("default");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // Simulates the one way an ownerless 'default' bucket could still exist — not
  // through the app (the test above rules that out), but a row inserted some
  // other way (a hand-run SQL statement, a future migration mistake, etc.). Proves
  // lib/bucket-access.ts fails closed regardless of *how* such a row got there,
  // which is the actual guarantee against this ever being "shared with all users"
  // again, not just that today's single INSERT call site behaves.
  it("is completely inert to every user if an ownerless row exists by any other means", async () => {
    const now = Math.floor(Date.now() / 1000);
    worker.execSql(
      `INSERT INTO buckets (id, owner_id, label, created_at) VALUES ('default', NULL, 'Orphaned default', ${now});`
    );

    const listRes = await fetch(`${worker.baseUrl}/admin/buckets`, {
      headers: { Authorization: `Bearer ${worker.apiKey}` },
    });
    const { buckets } = await asJson(listRes);
    expect(buckets.find((b: { id: string }) => b.id === "default")).toBeUndefined();

    const imagesRes = await fetch(`${worker.baseUrl}/admin/images?device_key=default`, {
      headers: { Authorization: `Bearer ${worker.apiKey}` },
    });
    expect(imagesRes.status).toBe(403);

    const subscribeRes = await fetch(`${worker.baseUrl}/admin/devices/${DEVICE_MAC}/buckets`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bucket_ids: ["default"] }),
    });
    expect(subscribeRes.status).toBe(403);

    const uploadRes = await fetch(`${worker.baseUrl}/admin/images/upload?device_key=default&filename=x.jpg`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "image/jpeg" },
      body: fs.readFileSync(path.join(FIXTURES_IMAGES_DIR, "default", "alpha.jpg")),
    });
    expect(uploadRes.status).toBe(403);

    worker.execSql(`DELETE FROM buckets WHERE id = 'default';`);
  });
});
