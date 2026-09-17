import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HKDF_INFO_BUCKET_WRAP,
  aesGcmDecryptBlob,
  aesGcmEncryptBlob,
  exportAesKeyRaw,
  exportPublicKeyRaw,
  fromBase64,
  fromBase64Url,
  generateBucketKey,
  generateP256KeyPair,
  importAesKeyRaw,
  toBase64,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyFor,
} from "../../src/client/crypto";
import { AdminClient } from "./lib/admin-client";
import { buildDummyBlob, buildTestPackedImage } from "./lib/test-image";
import { registerTestAccount } from "./lib/virtual-authenticator";
import { startWranglerDev, type WranglerDevHandle } from "./lib/wrangler-dev";

function randomMac(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Extracts the `#key=...` fragment's raw bytes from a full invite URL, the
 * same way the invitee's browser does client-side (see
 * src/client/admin.ts's readBucketKeyFragment). `AdminClient.inviteBucket`
 * only returns the query-string half (the real POST /admin/buckets/:id/invite
 * response never carries the raw key — see routes/admin/buckets.ts), so this
 * suite appends the fragment itself, exactly like createBucketInvite does,
 * rather than just reusing the raw key this process already holds in memory.
 */
function bucketKeyFromInviteUrl(urlWithFragment: string): Uint8Array {
  const hash = new URL(urlWithFragment).hash; // e.g. "#key=abc123"
  const match = /(?:^|[#&])key=([^&]+)/.exec(hash);
  if (!match) throw new Error(`invite URL has no #key= fragment: ${urlWithFragment}`);
  return fromBase64Url(match[1]!);
}

/**
 * Signs and sends a real GET /device_config request as a given device —
 * mirrors device_app.h's syncRemoteConfigAndTime() request signing (see
 * lib/device-signature.ts's hmacHex: HMAC-SHA256 over `mac|path|nonce`, keyed
 * by the device's own secret) closely enough to exercise the actual
 * bucket_keys payload a real device would unwrap, rather than reading D1
 * directly. `nonce` must strictly increase across calls for the same mac.
 */
async function fetchDeviceConfig(
  baseUrl: string,
  mac: string,
  secretHex: string,
  nonce: number
): Promise<{
  bucket_keys?: Array<{ bucket_id: string; key_version: number; ephemeral_pub: string; nonce: string; ciphertext: string }>;
}> {
  const signature = createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(`${mac}|/device_config|${nonce}`)
    .digest("hex");
  const res = await fetch(`${baseUrl}/device_config`, {
    headers: { "X-Device-MAC": mac, "X-Device-Nonce": String(nonce), "X-Device-Signature": signature },
  });
  if (!res.ok) throw new Error(`GET /device_config failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * End-to-end coverage of the *private* bucket sharing path (root CLAUDE.md's
 * encrypted-buckets plan) that neither existing e2e file covers:
 * registration-and-image-flow.test.ts is a single-account flow, and
 * public-buckets.test.ts is entirely about `is_public` buckets, whose
 * defining trait is that non-owners need no personal wrap at all. This file
 * covers the ordinary owner + invited-collaborator bucket — real invite
 * link (`POST /admin/buckets/:id/invite` -> `#key=` fragment ->
 * `POST /admin/buckets/join`), a third unrelated account that must see and
 * reach nothing, and a full key rotation across multiple principals
 * (owner, collaborator, and an assigned device).
 *
 * Against a real disposable `wrangler dev` (see lib/wrangler-dev.ts), with
 * real WebAuthn-registered accounts (lib/virtual-authenticator.ts) — no
 * firmware/simulator needed here, same reasoning as public-buckets.test.ts:
 * a "device" is just a Node-side P-256 keypair registered via its
 * sharing_public_key, and its /device_config requests are hand-signed the
 * same way real firmware would sign them.
 */
describe("e2e: private bucket sharing", () => {
  let wrangler: WranglerDevHandle;

  beforeAll(async () => {
    wrangler = await startWranglerDev({ port: 8796 });
  }, 60_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  it("an owner can share a private bucket via a real invite link; the collaborator gets genuine access and a third account is fully excluded", async () => {
    // --- Account A: owner, creates a private (non-public) bucket ---
    const { apiKey: apiKeyA } = await registerTestAccount(wrangler.baseUrl);
    const adminA = new AdminClient(wrangler.baseUrl, apiKeyA);

    const aKeyPair = await generateP256KeyPair();
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);
    const wrappedForA = await wrapKeyFor(await exportPublicKeyRaw(aKeyPair.publicKey), bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const { id: bucketId, is_public } = await adminA.createBucket("private-e2e-bucket", wrappedForA);
    expect(is_public).toBeFalsy();

    const { packed, packedHash } = buildTestPackedImage();
    await adminA.uploadImage(bucketId, "shared-e2e.bin", {
      packedHash,
      packed: await aesGcmEncryptBlob(bucketKey, packed),
      raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw")),
      thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb")),
    });

    // --- A creates a real invite link, exactly like admin.ts's createBucketInvite ---
    const invite = await adminA.inviteBucket(bucketId);
    const inviteUrlWithFragment = `${invite.url}#key=${toBase64Url(bucketKeyRaw)}`;
    const token = new URL(invite.url).searchParams.get("join_bucket");
    expect(token, "invite URL should carry a join_bucket token").toBeTruthy();

    // --- Account B: collaborator, joins using the token + the fragment key ---
    const { apiKey: apiKeyB } = await registerTestAccount(wrangler.baseUrl);
    const adminB = new AdminClient(wrangler.baseUrl, apiKeyB);
    const bKeyPair = await generateP256KeyPair();

    const rawKeyFromFragment = bucketKeyFromInviteUrl(inviteUrlWithFragment);
    expect(rawKeyFromFragment).toEqual(bucketKeyRaw);
    const wrappedForB = await wrapKeyFor(await exportPublicKeyRaw(bKeyPair.publicKey), rawKeyFromFragment, HKDF_INFO_BUCKET_WRAP);
    const joined = await adminB.joinBucket(token!, wrappedForB);
    expect(joined.id).toBe(bucketId);

    // B genuinely has real access: sees the bucket, can unwrap its own key,
    // and can decrypt an actual image with it — not just a 200 on /join.
    const bucketsForB = await adminB.getBuckets();
    const bucketForB = bucketsForB.find((b) => b.id === bucketId);
    expect(bucketForB, "B should see the shared bucket in GET /admin/buckets").toBeDefined();
    expect(bucketForB!.is_owner).toBe(false);
    expect(bucketForB!.is_public).toBe(false);
    expect(bucketForB!.key).not.toBeNull();

    const unwrappedForB = await unwrapKeyWith(bKeyPair.privateKey, bucketForB!.key!, HKDF_INFO_BUCKET_WRAP);
    expect(unwrappedForB).toEqual(bucketKeyRaw);
    const bucketKeyForB = await importAesKeyRaw(unwrappedForB);

    const imagesForB = await adminB.listImages(bucketId);
    expect(imagesForB).toHaveLength(1);
    const rawCiphertextForB = await adminB.getRawImageCiphertext(imagesForB[0]!.id);
    const decryptedForB = await aesGcmDecryptBlob(bucketKeyForB, rawCiphertextForB);
    expect(new TextDecoder().decode(decryptedForB)).toBe("e2e-test-raw");

    // --- Account C: unrelated third account, never received the invite ---
    const { apiKey: apiKeyC } = await registerTestAccount(wrangler.baseUrl);
    const adminC = new AdminClient(wrangler.baseUrl, apiKeyC);

    const bucketsForC = await adminC.getBuckets();
    expect(bucketsForC.find((b) => b.id === bucketId), "C should not see the private bucket at all").toBeUndefined();

    // Direct attempts against the bucket's images are rejected outright —
    // assertBucketAccess/assertBucketReadAccess (lib/bucket-access.ts) return
    // false for a non-public bucket C has no bucket_shares row for, and both
    // routes turn that into a 403 (not a 404, and never an empty-but-200 list).
    await expect(adminC.listImages(bucketId)).rejects.toThrow(/403/);
    await expect(adminC.getRawImageCiphertext(imagesForB[0]!.id)).rejects.toThrow(/403/);
  });

  it("rotating a private bucket re-wraps the key for the owner, a collaborator, and an assigned device, while a third account stays excluded", async () => {
    // --- Account A: owner ---
    const { apiKey: apiKeyA } = await registerTestAccount(wrangler.baseUrl);
    const adminA = new AdminClient(wrangler.baseUrl, apiKeyA);
    const meA = await adminA.getMe();

    const aKeyPair = await generateP256KeyPair();
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);
    const wrappedForA = await wrapKeyFor(await exportPublicKeyRaw(aKeyPair.publicKey), bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const { id: bucketId } = await adminA.createBucket("private-e2e-rotate-bucket", wrappedForA);

    const { packed: oldPacked, packedHash: oldHash } = buildTestPackedImage();
    await adminA.uploadImage(bucketId, "rotate-me.bin", {
      packedHash: oldHash,
      packed: await aesGcmEncryptBlob(bucketKey, oldPacked),
      raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw-v1")),
      thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb-v1")),
    });

    // --- A invites B; B joins for real (non-public) access ---
    const invite = await adminA.inviteBucket(bucketId);
    const token = new URL(invite.url).searchParams.get("join_bucket")!;
    const inviteKeyRaw = bucketKeyFromInviteUrl(`${invite.url}#key=${toBase64Url(bucketKeyRaw)}`);

    const { apiKey: apiKeyB, credentialId: credentialIdB } = await registerTestAccount(wrangler.baseUrl);
    const adminB = new AdminClient(wrangler.baseUrl, apiKeyB);
    const bKeyPair = await generateP256KeyPair();
    const wrappedForB = await wrapKeyFor(await exportPublicKeyRaw(bKeyPair.publicKey), inviteKeyRaw, HKDF_INFO_BUCKET_WRAP);
    await adminB.joinBucket(token, wrappedForB);
    // Backfill B's users.sharing_public_key (see AdminClient.setSharingPublicKey's
    // doc comment) - this is what lets the owner discover it later via GET
    // .../collaborators when finalizing the rotation below.
    await adminB.setSharingPublicKey(credentialIdB, toBase64(await exportPublicKeyRaw(bKeyPair.publicKey)));

    // --- A assigns the bucket to A's OWN device (not B's) — deliberately,
    //     so the owner can discover the device's sharing_public_key through
    //     the ordinary owner-scoped GET /admin/devices at finalize time. A
    //     non-owner assigning their own device to someone else's bucket hits
    //     a separate, already-documented gap (see public-buckets.test.ts's
    //     "KNOWN GAP" test) that this test isn't re-exercising. ---
    const deviceKeyPair = await generateP256KeyPair();
    const mac = randomMac();
    const deviceSecret = randomBytes(16).toString("hex");
    await adminA.registerDeviceWithSharingKey(mac, toBase64(await exportPublicKeyRaw(deviceKeyPair.publicKey)), deviceSecret);
    const wrappedForDevice = await wrapKeyFor(await exportPublicKeyRaw(deviceKeyPair.publicKey), bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    await adminA.assignBucketToDevice(mac, bucketId, wrappedForDevice);

    // Sanity: the device can already fetch and unwrap the pre-rotation key via
    // a real, HMAC-signed /device_config request (not a direct D1 read).
    const configBeforeRotation = await fetchDeviceConfig(wrangler.baseUrl, mac, deviceSecret, 1);
    const deviceEntryBefore = configBeforeRotation.bucket_keys?.find((k) => k.bucket_id === bucketId);
    expect(deviceEntryBefore?.key_version).toBe(1);
    const deviceUnwrappedBefore = await unwrapKeyWith(
      deviceKeyPair.privateKey,
      { ephemeralPub: deviceEntryBefore!.ephemeral_pub, nonce: deviceEntryBefore!.nonce, ciphertext: deviceEntryBefore!.ciphertext },
      HKDF_INFO_BUCKET_WRAP
    );
    expect(deviceUnwrappedBefore).toEqual(bucketKeyRaw);

    // --- Third, unrelated account: excluded before rotation too ---
    const { apiKey: apiKeyC } = await registerTestAccount(wrangler.baseUrl);
    const adminC = new AdminClient(wrangler.baseUrl, apiKeyC);
    expect((await adminC.getBuckets()).find((b) => b.id === bucketId)).toBeUndefined();

    // --- A rotates the bucket's key: start -> reencrypt every image -> finalize ---
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

    // A discovers B's sharing_public_key through the real owner-only endpoint
    // meant for exactly this purpose (GET .../collaborators), rather than
    // reusing bKeyPair.publicKey already held in this test process's memory —
    // a real owner's browser has no other way to learn a collaborator's key
    // at finalize time.
    const collaborators = await adminA.getCollaborators(bucketId);
    const bCollaborator = collaborators.find((collab) => collab.id !== meA.id);
    expect(bCollaborator?.sharing_public_key, "B's sharing_public_key should be discoverable by the owner").toBeTruthy();
    const wrappedForBNew = await wrapKeyFor(fromBase64(bCollaborator!.sharing_public_key!), newBucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const wrappedForDeviceNew = await wrapKeyFor(await exportPublicKeyRaw(deviceKeyPair.publicKey), newBucketKeyRaw, HKDF_INFO_BUCKET_WRAP);

    await adminA.rotateFinalize(bucketId, started.rotation_id, {
      user_keys: { [meA.id]: wrappedForANew, [bCollaborator!.id]: wrappedForBNew },
      device_keys: { [mac]: wrappedForDeviceNew },
    });

    // (a) owner can still decrypt every image after rotation.
    const bucketForAAfter = (await adminA.getBuckets()).find((b) => b.id === bucketId)!;
    expect(bucketForAAfter.key_version).toBe(2);
    const unwrappedForAAfter = await unwrapKeyWith(aKeyPair.privateKey, bucketForAAfter.key!, HKDF_INFO_BUCKET_WRAP);
    expect(unwrappedForAAfter).toEqual(newBucketKeyRaw);
    const imagesForAAfter = await adminA.listImages(bucketId);
    const rawForAAfter = await adminA.getRawImageCiphertext(imagesForAAfter[0]!.id);
    const decryptedForAAfter = await aesGcmDecryptBlob(await importAesKeyRaw(unwrappedForAAfter), rawForAAfter);
    expect(new TextDecoder().decode(decryptedForAAfter)).toBe("e2e-test-raw-v2");

    // (b) collaborator can still decrypt every image after rotation — B's
    // bucket_keys row was genuinely re-wrapped at the new key_version by
    // finalize, not left stale at the old one.
    const bucketForBAfter = (await adminB.getBuckets()).find((b) => b.id === bucketId)!;
    expect(bucketForBAfter.key_version).toBe(2);
    const unwrappedForBAfter = await unwrapKeyWith(bKeyPair.privateKey, bucketForBAfter.key!, HKDF_INFO_BUCKET_WRAP);
    expect(unwrappedForBAfter).toEqual(newBucketKeyRaw);
    const imagesForBAfter = await adminB.listImages(bucketId);
    const rawForBAfter = await adminB.getRawImageCiphertext(imagesForBAfter[0]!.id);
    const decryptedForBAfter = await aesGcmDecryptBlob(await importAesKeyRaw(unwrappedForBAfter), rawForBAfter);
    expect(new TextDecoder().decode(decryptedForBAfter)).toBe("e2e-test-raw-v2");

    // (c) third excluded account still cannot see/access the bucket after rotation.
    expect((await adminC.getBuckets()).find((b) => b.id === bucketId)).toBeUndefined();
    await expect(adminC.listImages(bucketId)).rejects.toThrow(/403/);

    // Device extension: the assigned device's wrapped key is genuinely
    // updated too. A fresh, real, signed /device_config request (nonce must
    // strictly advance past the one used before rotation) now returns only
    // the new-version wrap for this bucket — the old-version row was deleted
    // by finalize's actual revocation — and it unwraps to the new raw key.
    const configAfterRotation = await fetchDeviceConfig(wrangler.baseUrl, mac, deviceSecret, 2);
    const deviceEntriesAfter = configAfterRotation.bucket_keys?.filter((k) => k.bucket_id === bucketId) ?? [];
    expect(deviceEntriesAfter.map((k) => k.key_version)).toEqual([2]);
    const deviceUnwrappedAfter = await unwrapKeyWith(
      deviceKeyPair.privateKey,
      {
        ephemeralPub: deviceEntriesAfter[0]!.ephemeral_pub,
        nonce: deviceEntriesAfter[0]!.nonce,
        ciphertext: deviceEntriesAfter[0]!.ciphertext,
      },
      HKDF_INFO_BUCKET_WRAP
    );
    expect(deviceUnwrappedAfter).toEqual(newBucketKeyRaw);
  });
});
