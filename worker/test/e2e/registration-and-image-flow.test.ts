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
import { buildDummyBlob, buildTestPackedImage } from "./lib/test-image";
import { registerTestAccount } from "./lib/virtual-authenticator";
import { startWranglerDev, type WranglerDevHandle } from "./lib/wrangler-dev";

/**
 * End-to-end: the real `firmware/simulator` binary (real device_app.h/
 * display.cpp, unmodified) talking to a real, disposable `wrangler dev`
 * instance, covering the full self-registration + encrypted-image-display
 * flow described in root CLAUDE.md - the same path a brand new physical EE02
 * board takes from unboxing to showing its first photo:
 *
 *   unclaimed boot -> QR registration screen -> admin claims device ->
 *   admin creates a bucket + uploads an image -> admin assigns the bucket to
 *   the device -> device fetches, decrypts, and displays it -> a repeat
 *   fetch on a later wake keeps serving the same image correctly.
 *
 * Every crypto operation an admin's browser would normally do (bucket key
 * generation, ECIES wrapping for a principal) uses the real
 * src/client/crypto.ts functions, not a re-implementation - only the
 * WebAuthn ceremony (no browser/authenticator available here) and the image
 * decode/dither pipeline (replaced with a synthetic already-packed test
 * pattern - see lib/test-image.ts) are stood in for.
 *
 * Runs against a throwaway local `wrangler dev` (see lib/wrangler-dev.ts) -
 * never production - and needs `firmware/simulator`'s build prerequisites
 * (macOS, SDL2, clang++; see firmware/simulator/README.md). Not part of the
 * default `npm test` run (see vitest.config.ts's excludes) - run explicitly
 * with `npm run test:e2e`.
 */
describe("simulator e2e: registration + encrypted image display", () => {
  let wrangler: WranglerDevHandle;
  let workDir: string;

  beforeAll(async () => {
    buildSimulator("ee02");
    wrangler = await startWranglerDev();
    // Deliberately not cleaned up in afterAll - these JPEGs are the easiest
    // way to see what a failure actually looked like on the simulated panel.
    workDir = mkdtempSync(path.join(tmpdir(), "eink-e2e-snapshots-"));
    console.log(`e2e snapshots: ${workDir}`);
  }, 120_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  it("takes a device from unboxed to displaying its assigned image", async () => {
    // 1. Fresh, unclaimed boot: should render the "scan to register" QR
    //    screen and print its claim URL. This exact path used to silently
    //    fail to display anything - see device_app.h's isRegistrationImage
    //    handling in fetchAndDisplayImage().
    const firstBoot = runSimulatorOnce({
      server: wrangler.baseUrl,
      wifi: "Simulated-Test-WiFi",
      reset: true,
      exportPath: path.join(workDir, "boot1-registration.jpg"),
    });
    expect(firstBoot.claimUrl, "device should print its claim URL while unregistered").toBeDefined();
    expect(firstBoot.exportedJpegPaths).toHaveLength(1);
    const { mac, secret } = firstBoot.claimUrl!;

    const registrationScreen = await decodeJpeg(firstBoot.exportedJpegPaths[0]!);
    expect(countMagentaPixels(registrationScreen), "no unrecognized/undecoded pixels").toBe(0);

    // 2. Create an admin account through a real WebAuthn ceremony (the only
    //    way in - see auth-passkey.ts) and claim the device by its
    //    self-reported (mac, secret).
    const { apiKey } = await registerTestAccount(wrangler.baseUrl);
    const admin = new AdminClient(wrangler.baseUrl, apiKey);
    await admin.claimDevice(mac, secret);

    // 3. Second boot: claimed, but not in any bucket yet. This is also what
    //    gets the device's sharing_public_key onto its devices row -
    //    recordDeviceSeen() no-ops for an unclaimed mac, so there was no
    //    earlier point where the Worker could have learned it.
    runSimulatorOnce({ server: wrangler.baseUrl, exportPath: path.join(workDir, "boot2-claimed.jpg") });

    const [device] = await admin.listDevices();
    expect(device?.sharing_public_key, "device should have self-reported its sharing key by now").toBeTruthy();

    // 4. Create a bucket, upload a distinctive test image, and assign the
    //    bucket to the device - using the real client-side crypto (bucket
    //    key generation, ECIES wrapping) an admin's browser would run.
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);

    const ownerKeyPair = await generateP256KeyPair();
    const wrappedForOwner = await wrapKeyFor(
      await exportPublicKeyRaw(ownerKeyPair.publicKey),
      bucketKeyRaw,
      HKDF_INFO_BUCKET_WRAP
    );
    const { id: bucketId } = await admin.createBucket("e2e-test-bucket", wrappedForOwner);

    const { packed, packedHash } = buildTestPackedImage();
    await admin.uploadImage(bucketId, "e2e-test.bin", {
      packedHash,
      packed: await aesGcmEncryptBlob(bucketKey, packed),
      raw: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw")),
      thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb")),
    });

    const devicePublicKeyRaw = fromBase64(device!.sharing_public_key!);
    const wrappedForDevice = await wrapKeyFor(devicePublicKeyRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    await admin.assignBucketToDevice(mac, bucketId, wrappedForDevice);

    // 5. Third boot: the device should now unwrap the bucket key from
    //    /device_config, decrypt /image_packed, and actually display the
    //    uploaded image - top half black, bottom half red.
    const thirdBoot = runSimulatorOnce({ server: wrangler.baseUrl, exportPath: path.join(workDir, "boot3-image.jpg") });
    expect(thirdBoot.exportedJpegPaths).toHaveLength(1);

    // Note: the exported JPEG is the simulator's undo-rotated *portrait* view
    // (see display_render.cpp's present()) - its height is the landscape
    // buffer's WIDTH (1600), not EE02_HEIGHT (1200), so the row fractions
    // below are computed off the actual decoded image, not that constant.
    const displayed = await decodeJpeg(thirdBoot.exportedJpegPaths[0]!);
    const top = averageColorInRow(displayed, Math.floor(displayed.height * 0.25));
    expect(top.r).toBeLessThan(30);
    expect(top.g).toBeLessThan(30);
    expect(top.b).toBeLessThan(30);

    const bottom = averageColorInRow(displayed, Math.floor(displayed.height * 0.75));
    expect(bottom.r).toBeGreaterThan(200);
    expect(bottom.g).toBeLessThan(60);
    expect(bottom.b).toBeLessThan(60);
    expect(thirdBoot.stdout).toContain(`X-Image-Hash=${packedHash}`);

    // 6. Fourth boot: still the same single image in the same bucket -
    //    rotation should keep serving it consistently rather than advancing
    //    past it or serving garbage on a repeat fetch.
    //
    //    This can't assert the device's known_hash/304 change-detection path
    //    itself: that relies on RtcState (RTC_DATA_ATTR), which survives real
    //    deep sleep because deep sleep keeps RAM powered, and likewise
    //    survives a wake in the simulator's own single long-running process
    //    (see main_native.cpp's outer loop) - but each runSimulatorOnce()
    //    call here is a separate OS process, closer to a real power-cycle
    //    than a deep-sleep wake, so rtc.lastImageHash is legitimately empty
    //    again at the start of this one.
    const fourthBoot = runSimulatorOnce({ server: wrangler.baseUrl, exportPath: path.join(workDir, "boot4-still-image.jpg") });
    expect(fourthBoot.stdout).toContain(`X-Image-Hash=${packedHash}`);
    const displayedAgain = await decodeJpeg(fourthBoot.exportedJpegPaths[0]!);
    expect(averageColorInRow(displayedAgain, Math.floor(displayedAgain.height * 0.25)).r).toBeLessThan(30);
    expect(averageColorInRow(displayedAgain, Math.floor(displayedAgain.height * 0.75)).r).toBeGreaterThan(200);
  });
});
