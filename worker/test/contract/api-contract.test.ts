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

/** Builds the X-Device-Timestamp/X-Device-Signature headers lib/device-signature.ts
 *  requires for a registered device's requests, alongside X-Device-MAC. */
function signedHeaders(requestPath: string): Record<string, string> {
  const timestamp = Date.now();
  const signature = crypto
    .createHmac("sha256", Buffer.from(DEVICE_SECRET, "hex"))
    .update(`${DEVICE_MAC}|${requestPath}|${timestamp}`)
    .digest("hex");
  return {
    "X-Device-MAC": DEVICE_MAC,
    "X-Device-Timestamp": String(timestamp),
    "X-Device-Signature": signature,
  };
}

let python: PythonServerHandle;
let worker: WorkerServerHandle;

async function uploadToWorker(deviceKey: string, filename: string): Promise<void> {
  const bytes = fs.readFileSync(path.join(FIXTURES_IMAGES_DIR, deviceKey, filename));
  const res = await fetch(
    `${worker.baseUrl}/admin/images/upload?device_key=${deviceKey}&filename=${filename}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "image/jpeg" },
      body: bytes,
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to seed ${deviceKey}/${filename} on worker: ${res.status} ${await res.text()}`);
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

  // Python's rotation is fallback-only (device dir if present, else 'default' —
  // never both). The Worker's include_default_images merge (migrations/0003)
  // defaults to on, which would double-count this device's own images against
  // the shared 'default' bucket seeded below — disable it to keep the two
  // backends comparable for this parity suite.
  await fetch(`${worker.baseUrl}/admin/devices/${DEVICE_MAC}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ include_default_images: false }),
  });

  await fetch(`${worker.baseUrl}/admin/schedule/${DEVICE_MAC}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${worker.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(SCHEDULE_FIXTURE),
  });

  // Rotation order is alphabetical-by-filename on both backends, so uploading
  // under the same filenames keeps peek/advance sequencing directly comparable.
  await uploadToWorker("default", "alpha.jpg");
  await uploadToWorker("default", "beta.jpg");
  await uploadToWorker(DEVICE_MAC, "one.jpg");
  await uploadToWorker(DEVICE_MAC, "two.jpg");
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
});

describe("GET /current", () => {
  it("reports the same total image count and device identity on both backends", async () => {
    const [pyRes, workerRes] = await Promise.all([
      fetch(`${python.baseUrl}/current?device=${DEVICE_MAC}`),
      fetch(`${worker.baseUrl}/current?device=${DEVICE_MAC}`),
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
});
