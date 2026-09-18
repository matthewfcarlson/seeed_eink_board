import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HKDF_INFO_BUCKET_WRAP,
  aesGcmEncryptBlob,
  exportAesKeyRaw,
  exportPublicKeyRaw,
  fromBase64,
  generateBucketKey,
  generateP256KeyPair,
  wrapKeyFor,
} from "../../src/client/crypto";
import { AdminClient } from "./lib/admin-client";
import { averageColorInRow, countMagentaPixels, decodeJpeg } from "./lib/jpeg-utils";
import { buildSimulator, runSimulatorOnce } from "./lib/simulator";
import { buildDummyBlob, buildEe04TestPackedImage, EE04_HEIGHT } from "./lib/test-image";
import { registerTestAccount } from "./lib/virtual-authenticator";
import { startWranglerDev, type WranglerDevHandle } from "./lib/wrangler-dev";

/**
 * Same shape as registration-and-image-flow.test.ts, but for EE04 (800x480,
 * no on-device rotation - see lib/media-constants.ts's BoardGeometry) -
 * added alongside migrations/0019_bucket_target_board.sql to reproduce and
 * cover the exact bug that motivated it: an EE04 device's /image_packed
 * requests (both the "no bucket assigned" placeholder and a real assigned
 * image) used to always come back sized for EE02 (960,000 bytes), which the
 * firmware correctly rejected with "Invalid content length" and left the
 * previous image on screen. This suite fails the same way on the
 * pre-migration code and should pass once a bucket's target_board actually
 * drives the served geometry.
 */
describe("simulator e2e: EE04 registration + encrypted image display", () => {
  let wrangler: WranglerDevHandle;
  let workDir: string;

  beforeAll(async () => {
    buildSimulator("ee04");
    wrangler = await startWranglerDev();
    workDir = mkdtempSync(path.join(tmpdir(), "eink-e2e-ee04-snapshots-"));
    console.log(`e2e snapshots: ${workDir}`);
  }, 120_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  it("takes an EE04 device from unboxed to displaying its assigned image", async () => {
    // 1. Fresh, unclaimed boot: registration QR screen, sized for EE04
    //    (800x480), not the EE02 geometry the pipeline used to hardcode.
    const firstBoot = runSimulatorOnce({
      board: "ee04",
      server: wrangler.baseUrl,
      wifi: "Simulated-Test-WiFi",
      reset: true,
      exportPath: path.join(workDir, "boot1-registration.jpg"),
    });
    expect(firstBoot.stdout).not.toContain("Invalid content length");
    expect(firstBoot.stdout).not.toContain("Image fetch/display failed");
    expect(firstBoot.claimUrl, "device should print its claim URL while unregistered").toBeDefined();
    expect(firstBoot.exportedJpegPaths).toHaveLength(1);
    const { mac, secret } = firstBoot.claimUrl!;

    const registrationScreen = await decodeJpeg(firstBoot.exportedJpegPaths[0]!);
    expect(registrationScreen.width).toBe(800);
    expect(registrationScreen.height).toBe(480);
    expect(countMagentaPixels(registrationScreen), "no unrecognized/undecoded pixels").toBe(0);

    // 2. Claim the device, then reboot with zero buckets assigned - this is
    //    the exact repro of the original bug report: a registered device
    //    with nothing to show used to get an EE02-sized placeholder and fail
    //    its own content-length check.
    const { apiKey } = await registerTestAccount(wrangler.baseUrl);
    const admin = new AdminClient(wrangler.baseUrl, apiKey);
    await admin.claimDevice(mac, secret);

    const noBucketBoot = runSimulatorOnce({ board: "ee04", server: wrangler.baseUrl, exportPath: path.join(workDir, "boot2-no-bucket.jpg") });
    expect(noBucketBoot.stdout).not.toContain("Invalid content length");
    expect(noBucketBoot.stdout).not.toContain("Image fetch/display failed");
    expect(noBucketBoot.stdout).toContain("X-Image-Name=no-images-available");
    expect(noBucketBoot.exportedJpegPaths).toHaveLength(1);
    const noBucketScreen = await decodeJpeg(noBucketBoot.exportedJpegPaths[0]!);
    expect(noBucketScreen.width).toBe(800);
    expect(noBucketScreen.height).toBe(480);
    expect(countMagentaPixels(noBucketScreen), "no unrecognized/undecoded pixels").toBe(0);

    const [device] = await admin.listDevices();
    expect(device?.sharing_public_key, "device should have self-reported its sharing key by now").toBeTruthy();

    // 3. Create an EE04-targeted bucket, upload a distinctive EE04-sized test
    //    image (192,000 bytes, not EE02's 960,000), assign it to the device.
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);

    const ownerKeyPair = await generateP256KeyPair();
    const wrappedForOwner = await wrapKeyFor(
      await exportPublicKeyRaw(ownerKeyPair.publicKey),
      bucketKeyRaw,
      HKDF_INFO_BUCKET_WRAP
    );
    const { id: bucketId, target_board } = await admin.createBucket("e2e-ee04-bucket", wrappedForOwner, {
      target_board: "ee04-7in3",
    });
    expect(target_board).toBe("ee04-7in3");

    const { packed, packedHash } = buildEe04TestPackedImage();
    await admin.uploadImage(bucketId, "e2e-ee04-test.bin", {
      packedHash,
      packed: await aesGcmEncryptBlob(bucketKey, packed),
      raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw")),
      thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb")),
    });

    const devicePublicKeyRaw = fromBase64(device!.sharing_public_key!);
    const wrappedForDevice = await wrapKeyFor(devicePublicKeyRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    await admin.assignBucketToDevice(mac, bucketId, wrappedForDevice);

    // 4. Third boot: the device should now unwrap the bucket key, decrypt
    //    the correctly-800x480-sized /image_packed body, and display it -
    //    top half black, bottom half red - with no content-length rejection.
    const thirdBoot = runSimulatorOnce({ board: "ee04", server: wrangler.baseUrl, exportPath: path.join(workDir, "boot3-image.jpg") });
    expect(thirdBoot.stdout).not.toContain("Invalid content length");
    expect(thirdBoot.stdout).not.toContain("Image fetch/display failed");
    expect(thirdBoot.stdout).toContain(`X-Image-Hash=${packedHash}`);
    expect(thirdBoot.exportedJpegPaths).toHaveLength(1);

    const displayed = await decodeJpeg(thirdBoot.exportedJpegPaths[0]!);
    expect(displayed.width).toBe(800);
    expect(displayed.height).toBe(480);
    const top = averageColorInRow(displayed, Math.floor(EE04_HEIGHT * 0.25));
    expect(top.r).toBeLessThan(30);
    expect(top.g).toBeLessThan(30);
    expect(top.b).toBeLessThan(30);

    const bottom = averageColorInRow(displayed, Math.floor(EE04_HEIGHT * 0.75));
    expect(bottom.r).toBeGreaterThan(200);
    expect(bottom.g).toBeLessThan(60);
    expect(bottom.b).toBeLessThan(60);
  });
});
