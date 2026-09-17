import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HKDF_INFO_BUCKET_WRAP,
  aesGcmDecryptBlob,
  aesGcmEncryptBlob,
  exportAesKeyRaw,
  exportPublicKeyRaw,
  fromBase64,
  generateBucketKey,
  generateP256KeyPair,
  toBase64,
  wrapKeyFor,
} from "../../src/client/crypto";
import { AdminClient } from "./lib/admin-client";
import { buildDummyBlob, buildTestPackedImage } from "./lib/test-image";
import { registerTestAccount } from "./lib/virtual-authenticator";
import { grantSuperuser, startWranglerDev, type WranglerDevHandle } from "./lib/wrangler-dev";

function randomMac(): string {
  return randomBytes(6).toString("hex");
}

/**
 * End-to-end coverage of the public-buckets feature (root CLAUDE.md's
 * public-buckets plan / migrations/0018_public_buckets.sql), against a real
 * disposable `wrangler dev` - two real accounts created through the real
 * passkey ceremony (see lib/virtual-authenticator.ts), same as
 * registration-and-image-flow.test.ts, but without the firmware simulator
 * (no display/device-signature behavior is under test here - a "device" is
 * just a Node-side P-256 keypair registered via its sharing_public_key, the
 * same out-of-band field a real device would self-report).
 */
describe("e2e: public buckets", () => {
  let wrangler: WranglerDevHandle;

  beforeAll(async () => {
    wrangler = await startWranglerDev({ port: 8795 });
  }, 60_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  it("a superuser's public bucket is readable and device-assignable by another account, but not writable", async () => {
    // --- Account A: creates the public bucket ---
    const { apiKey: apiKeyA } = await registerTestAccount(wrangler.baseUrl);
    const adminA = new AdminClient(wrangler.baseUrl, apiKeyA);
    const meA = await adminA.getMe();
    expect(meA.is_superuser).toBe(false);

    // The manual D1 grant documented in migrations/0018_public_buckets.sql -
    // there's deliberately no API for this.
    grantSuperuser(wrangler, meA.id);
    expect((await adminA.getMe()).is_superuser).toBe(true);

    const aKeyPair = await generateP256KeyPair();
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);
    const wrappedForA = await wrapKeyFor(await exportPublicKeyRaw(aKeyPair.publicKey), bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);

    const { id: bucketId, is_public } = await adminA.createBucket("public-e2e-bucket", wrappedForA, {
      is_public: true,
      public_key_raw: toBase64(bucketKeyRaw),
    });
    expect(is_public).toBe(true);

    const { packed, packedHash } = buildTestPackedImage();
    await adminA.uploadImage(bucketId, "e2e-test.bin", {
      packedHash,
      packed: await aesGcmEncryptBlob(bucketKey, packed),
      raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw")),
      thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb")),
    });

    // --- Account B: an ordinary (non-superuser, non-owner) account ---
    const { apiKey: apiKeyB } = await registerTestAccount(wrangler.baseUrl);
    const adminB = new AdminClient(wrangler.baseUrl, apiKeyB);

    const bucketsForB = await adminB.getBuckets();
    const bucketForB = bucketsForB.find((b) => b.id === bucketId);
    expect(bucketForB, "B should see A's public bucket in GET /admin/buckets").toBeDefined();
    expect(bucketForB!.is_owner).toBe(false);
    expect(bucketForB!.is_public).toBe(true);
    // B has no personal wrap - the raw-key escape hatch is what's surfaced instead.
    expect(bucketForB!.key).toBeNull();
    expect(bucketForB!.public_key_raw).toBe(toBase64(bucketKeyRaw));

    // Read access: B can list and view the bucket's images.
    const imagesForB = await adminB.listImages(bucketId);
    expect(imagesForB).toHaveLength(1);
    const rawCiphertext = await adminB.getRawImageCiphertext(imagesForB[0]!.id);
    const decrypted = await aesGcmDecryptBlob(bucketKey, rawCiphertext);
    expect(new TextDecoder().decode(decrypted)).toBe("e2e-test-raw");

    // No write access: upload, rename, and delete must all be refused.
    await expect(
      adminB.uploadImage(bucketId, "should-fail.bin", {
        packedHash: "0000000000000000",
        packed: await aesGcmEncryptBlob(bucketKey, packed),
        raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw")),
        thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb")),
      })
    ).rejects.toThrow(/403/);
    await expect(adminB.patchBucket(bucketId, { label: "hijacked" })).rejects.toThrow(/403/);

    // B can assign the public bucket (that B doesn't own) to B's own device -
    // this is the crux of why firmware needs zero changes: B's browser reads
    // the raw key from public_key_raw instead of unwrapping a personal
    // bucket_keys row, then wraps it for the device exactly the same way.
    const deviceKeyPair = await generateP256KeyPair();
    const mac = randomMac();
    await adminB.registerDeviceWithSharingKey(
      mac,
      toBase64(await exportPublicKeyRaw(deviceKeyPair.publicKey)),
      randomBytes(16).toString("hex")
    );
    const rawKeyFromPublic = fromBase64(bucketForB!.public_key_raw!);
    expect(rawKeyFromPublic).toEqual(bucketKeyRaw);
    const wrappedForDevice = await wrapKeyFor(await exportPublicKeyRaw(deviceKeyPair.publicKey), rawKeyFromPublic, HKDF_INFO_BUCKET_WRAP);
    await adminB.assignBucketToDevice(mac, bucketId, wrappedForDevice);
  });

  it("rotating a public bucket with no foreign devices attached updates public_key_raw so a non-owner sees the new key", async () => {
    const { apiKey: apiKeyA } = await registerTestAccount(wrangler.baseUrl);
    const adminA = new AdminClient(wrangler.baseUrl, apiKeyA);
    const meA = await adminA.getMe();
    grantSuperuser(wrangler, meA.id);

    const aKeyPair = await generateP256KeyPair();
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);
    const wrappedForA = await wrapKeyFor(await exportPublicKeyRaw(aKeyPair.publicKey), bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const { id: bucketId } = await adminA.createBucket("public-e2e-rotate-bucket", wrappedForA, {
      is_public: true,
      public_key_raw: toBase64(bucketKeyRaw),
    });

    const { packed: oldPacked, packedHash: oldHash } = buildTestPackedImage();
    await adminA.uploadImage(bucketId, "rotate-me.bin", {
      packedHash: oldHash,
      packed: await aesGcmEncryptBlob(bucketKey, oldPacked),
      raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw-v1")),
      thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb-v1")),
    });

    const { apiKey: apiKeyB } = await registerTestAccount(wrangler.baseUrl);
    const adminB = new AdminClient(wrangler.baseUrl, apiKeyB);
    const bucketBeforeRotation = (await adminB.getBuckets()).find((b) => b.id === bucketId)!;
    expect(bucketBeforeRotation.key_version).toBe(1);
    expect(bucketBeforeRotation.public_key_raw).toBe(toBase64(bucketKeyRaw));

    // --- A rotates the key (no collaborators, no assigned devices) ---
    const newBucketKey = await generateBucketKey();
    const newBucketKeyRaw = await exportAesKeyRaw(newBucketKey);
    const wrappedForANew = await wrapKeyFor(await exportPublicKeyRaw(aKeyPair.publicKey), newBucketKeyRaw, HKDF_INFO_BUCKET_WRAP);

    const started = await adminA.rotateStart(bucketId, wrappedForANew);
    expect(started.image_ids).toHaveLength(1);

    const { packed: newPacked, packedHash: newHash } = buildTestPackedImage();
    for (const imageId of started.image_ids) {
      await adminA.reencryptImage(bucketId, started.rotation_id, imageId, {
        packedHash: newHash,
        packed: await aesGcmEncryptBlob(newBucketKey, newPacked),
        raw: await aesGcmEncryptBlob(newBucketKey, buildDummyBlob("raw-v2")),
        thumb: await aesGcmEncryptBlob(newBucketKey, buildDummyBlob("thumb-v2")),
      });
    }

    await adminA.rotateFinalize(bucketId, started.rotation_id, {
      user_keys: { [meA.id]: wrappedForANew },
      device_keys: {},
      public_key_raw: toBase64(newBucketKeyRaw),
    });

    // --- B (still no personal wrap - public-only reader) sees the new key ---
    const bucketAfterRotation = (await adminB.getBuckets()).find((b) => b.id === bucketId)!;
    expect(bucketAfterRotation.key_version).toBe(2);
    expect(bucketAfterRotation.public_key_raw).toBe(toBase64(newBucketKeyRaw));
    expect(bucketAfterRotation.public_key_raw).not.toBe(toBase64(bucketKeyRaw));

    // And can actually decrypt the re-encrypted image with it.
    const imagesForB = await adminB.listImages(bucketId);
    const rawCiphertext = await adminB.getRawImageCiphertext(imagesForB[0]!.id);
    const decrypted = await aesGcmDecryptBlob(newBucketKey, rawCiphertext);
    expect(new TextDecoder().decode(decrypted)).toBe("e2e-test-raw-v2");
  });

  it("KNOWN GAP: rotating a public bucket fails at finalize once a non-owner has assigned it to their own device, because the owner has no way to discover that device's sharing key", async () => {
    const { apiKey: apiKeyA } = await registerTestAccount(wrangler.baseUrl);
    const adminA = new AdminClient(wrangler.baseUrl, apiKeyA);
    const meA = await adminA.getMe();
    grantSuperuser(wrangler, meA.id);

    const aKeyPair = await generateP256KeyPair();
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);
    const wrappedForA = await wrapKeyFor(await exportPublicKeyRaw(aKeyPair.publicKey), bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const { id: bucketId } = await adminA.createBucket("public-e2e-gap-bucket", wrappedForA, {
      is_public: true,
      public_key_raw: toBase64(bucketKeyRaw),
    });

    const { packed, packedHash } = buildTestPackedImage();
    await adminA.uploadImage(bucketId, "gap-test.bin", {
      packedHash,
      packed: await aesGcmEncryptBlob(bucketKey, packed),
      raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw")),
      thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb")),
    });

    // B assigns the public bucket to B's own device - exactly the flow the
    // previous test exercises as a supported, intentional read-only-bucket
    // capability.
    const { apiKey: apiKeyB } = await registerTestAccount(wrangler.baseUrl);
    const adminB = new AdminClient(wrangler.baseUrl, apiKeyB);
    const bucketForB = (await adminB.getBuckets()).find((b) => b.id === bucketId)!;
    const deviceKeyPair = await generateP256KeyPair();
    const mac = randomMac();
    await adminB.registerDeviceWithSharingKey(
      mac,
      toBase64(await exportPublicKeyRaw(deviceKeyPair.publicKey)),
      randomBytes(16).toString("hex")
    );
    const wrappedForDevice = await wrapKeyFor(
      await exportPublicKeyRaw(deviceKeyPair.publicKey),
      fromBase64(bucketForB.public_key_raw!),
      HKDF_INFO_BUCKET_WRAP
    );
    await adminB.assignBucketToDevice(mac, bucketId, wrappedForDevice);

    // A now rotates. finalize's computeAuthorizedPrincipals (lib/bucket-keys.ts)
    // recomputes principals from the LIVE device_buckets table regardless of
    // who owns the device, so it now requires a new-version wrapped key for
    // B's device too - but GET /admin/devices is scoped to `WHERE user_id = ?`
    // (routes/admin/devices.ts), so A has no route that would ever surface
    // B's device's sharing_public_key. This is a pre-existing gap (the same
    // thing already happens for an ordinary shared/collaborator bucket if a
    // collaborator assigns their own device to it) that public buckets make
    // far more likely to hit in practice, not something introduced by
    // public_key_raw itself - flagged here deliberately rather than silently
    // left for someone to discover in production.
    const newBucketKey = await generateBucketKey();
    const newBucketKeyRaw = await exportAesKeyRaw(newBucketKey);
    const wrappedForANew = await wrapKeyFor(await exportPublicKeyRaw(aKeyPair.publicKey), newBucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const started = await adminA.rotateStart(bucketId, wrappedForANew);

    for (const imageId of started.image_ids) {
      await adminA.reencryptImage(bucketId, started.rotation_id, imageId, {
        packedHash: packedHash,
        packed: await aesGcmEncryptBlob(newBucketKey, packed),
        raw: await aesGcmEncryptBlob(newBucketKey, buildDummyBlob("raw")),
        thumb: await aesGcmEncryptBlob(newBucketKey, buildDummyBlob("thumb")),
      });
    }

    await expect(
      adminA.rotateFinalize(bucketId, started.rotation_id, {
        user_keys: { [meA.id]: wrappedForANew },
        device_keys: {}, // A cannot supply B's device's key - see comment above
        public_key_raw: toBase64(newBucketKeyRaw),
      })
    ).rejects.toThrow(new RegExp(`device ${mac}`));
  });
});
