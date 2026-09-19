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
import { buildSimulator, runSimulatorOnce, type SimBoard } from "./lib/simulator";
import { buildDummyBlob, buildEe04TestPackedImage, buildTestPackedImage } from "./lib/test-image";
import { registerTestAccount } from "./lib/virtual-authenticator";
import { startWranglerDev, type WranglerDevHandle } from "./lib/wrangler-dev";

/**
 * End-to-end: the real `firmware/simulator` binary (real device_app.h/
 * display.cpp, unmodified) for BOTH boards, talking to a real, disposable
 * `wrangler dev` instance, covering the full self-registration + encrypted-
 * image-display flow described in root CLAUDE.md - the same path a brand
 * new physical board takes from unboxing to showing its first photo:
 *
 *   unclaimed boot -> QR registration screen -> admin claims device ->
 *   admin creates a bucket + uploads ONE image -> admin assigns that SAME
 *   bucket to BOTH an EE02 and an EE04 device -> each device fetches,
 *   decrypts, and displays its own board's rendition of it.
 *
 * It then proves schedule-driven quiet hours end to end: a real
 * PUT /admin/schedule override (one-hour window two hours ahead of
 * device-local now, so deterministically quiet) makes the device sync
 * config/time but defer the image fetch entirely (nothing rendered, rotation
 * cursor untouched); flipping the same device's schedule to always-active
 * makes the SAME image display, proving the deferral was schedule-driven.
 *
 * This is the direct proof of migrations/0019_image_board_variants.sql: a
 * bucket was never board-scoped (device_buckets is plain many-to-many), and
 * now neither is an image - uploading once produces every board's variant,
 * so any mix of device boards subscribed to the same bucket just works,
 * rather than needing a separate bucket (and a second upload) per board.
 *
 * Every crypto operation an admin's browser would normally do (bucket key
 * generation, ECIES wrapping for a principal) uses the real
 * src/client/crypto.ts functions, not a re-implementation - only the
 * WebAuthn ceremony (no browser/authenticator available here) and the image
 * decode/dither pipeline (replaced with synthetic already-packed test
 * patterns - see lib/test-image.ts) are stood in for.
 *
 * Runs against a throwaway local `wrangler dev` (see lib/wrangler-dev.ts) -
 * never production - and needs `firmware/simulator`'s build prerequisites
 * (macOS, SDL2, clang++; see firmware/simulator/README.md). Not part of the
 * default `npm test` run (see vitest.config.ts's excludes) - run explicitly
 * with `npm run test:e2e`.
 */
describe("simulator e2e: one bucket serves both EE02 and EE04 devices", () => {
  let wrangler: WranglerDevHandle;
  let workDir: string;

  beforeAll(async () => {
    buildSimulator("ee02");
    buildSimulator("ee04");
    wrangler = await startWranglerDev();
    // Deliberately not cleaned up in afterAll - these JPEGs are the easiest
    // way to see what a failure actually looked like on the simulated panel.
    workDir = mkdtempSync(path.join(tmpdir(), "eink-e2e-snapshots-"));
    console.log(`e2e snapshots: ${workDir}`);
  }, 120_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  /** Both boards are mounted physically rotated (config.h's
   *  DISPLAY_MOUNTED_ROTATED) - the simulator's display_render.cpp undoes
   *  that for on-screen/export display, so the exported JPEG is portrait,
   *  swapped from each board's native landscape buffer dimensions. */
  const EXPECTED_PORTRAIT: Record<SimBoard, { width: number; height: number }> = {
    ee02: { width: 1200, height: 1600 },
    ee04: { width: 480, height: 800 },
  };

  async function bootUnclaimed(board: SimBoard, label: string) {
    const boot = runSimulatorOnce({
      board,
      server: wrangler.baseUrl,
      wifi: "Simulated-Test-WiFi",
      reset: true,
      exportPath: path.join(workDir, `${board}-${label}.jpg`),
    });
    expect(boot.claimUrl, `${board} device should print its claim URL while unregistered`).toBeDefined();
    expect(boot.exportedJpegPaths).toHaveLength(1);

    const screen = await decodeJpeg(boot.exportedJpegPaths[0]!);
    expect(screen.width, `${board} registration screen width`).toBe(EXPECTED_PORTRAIT[board].width);
    expect(screen.height, `${board} registration screen height`).toBe(EXPECTED_PORTRAIT[board].height);
    expect(countMagentaPixels(screen), `${board} registration screen: no unrecognized/undecoded pixels`).toBe(0);

    return boot.claimUrl!;
  }

  function bootNoBucket(board: SimBoard, label: string) {
    const boot = runSimulatorOnce({ board, server: wrangler.baseUrl, exportPath: path.join(workDir, `${board}-${label}.jpg`) });
    expect(boot.stdout).not.toContain("Invalid content length");
    expect(boot.stdout).not.toContain("Image fetch/display failed");
    expect(boot.stdout).toContain("X-Image-Name=no-images-available");
    expect(boot.exportedJpegPaths).toHaveLength(1);
    return boot;
  }

  async function assertNoBucketScreen(board: SimBoard, boot: ReturnType<typeof runSimulatorOnce>) {
    const screen = await decodeJpeg(boot.exportedJpegPaths[0]!);
    expect(screen.width, `${board} no-bucket screen width`).toBe(EXPECTED_PORTRAIT[board].width);
    expect(screen.height, `${board} no-bucket screen height`).toBe(EXPECTED_PORTRAIT[board].height);
    expect(countMagentaPixels(screen), `${board} no-bucket screen: no unrecognized/undecoded pixels`).toBe(0);
  }

  async function assertDisplaysUploadedImage(
    board: SimBoard,
    label: string,
    expectedHash: string,
    bootOpts: Partial<Parameters<typeof runSimulatorOnce>[0]> = {}
  ) {
    const boot = runSimulatorOnce({ board, server: wrangler.baseUrl, exportPath: path.join(workDir, `${board}-${label}.jpg`), ...bootOpts });
    expect(boot.stdout).not.toContain("Invalid content length");
    expect(boot.stdout).not.toContain("Image fetch/display failed");
    expect(boot.stdout).toContain(`X-Image-Hash=${expectedHash}`);
    expect(boot.exportedJpegPaths).toHaveLength(1);

    const displayed = await decodeJpeg(boot.exportedJpegPaths[0]!);
    expect(displayed.width, `${board} displayed image width`).toBe(EXPECTED_PORTRAIT[board].width);
    expect(displayed.height, `${board} displayed image height`).toBe(EXPECTED_PORTRAIT[board].height);

    const top = averageColorInRow(displayed, Math.floor(displayed.height * 0.25));
    expect(top.r, `${board} top band red`).toBeLessThan(30);
    expect(top.g, `${board} top band green`).toBeLessThan(30);
    expect(top.b, `${board} top band blue`).toBeLessThan(30);

    const bottom = averageColorInRow(displayed, Math.floor(displayed.height * 0.75));
    expect(bottom.r, `${board} bottom band red`).toBeGreaterThan(200);
    expect(bottom.g, `${board} bottom band green`).toBeLessThan(60);
    expect(bottom.b, `${board} bottom band blue`).toBeLessThan(60);
  }

  it("takes an EE02 and an EE04 device from unboxed to both displaying one shared bucket's image", async () => {
    // 1. Fresh, unclaimed boot for each board: registration QR screen, sized
    //    correctly for that board (not hardcoded to EE02 - this exact path
    //    used to silently fail to display anything for EE04, and before
    //    that for EE02 too - see device_app.h's isRegistrationImage handling
    //    in fetchAndDisplayImage()).
    const ee02Claim = await bootUnclaimed("ee02", "boot1-registration");
    const ee04Claim = await bootUnclaimed("ee04", "boot1-registration");

    // 2. Create an admin account through a real WebAuthn ceremony (the only
    //    way in - see auth-passkey.ts) and claim both devices by their
    //    self-reported (mac, secret).
    const { apiKey } = await registerTestAccount(wrangler.baseUrl);
    const admin = new AdminClient(wrangler.baseUrl, apiKey);
    await admin.claimDevice(ee02Claim.mac, ee02Claim.secret);
    await admin.claimDevice(ee04Claim.mac, ee04Claim.secret);

    // 3. Second boot each: claimed, but not in any bucket yet - the exact
    //    repro of the original EE04 bug report (a registered device with
    //    nothing to show used to get an EE02-sized placeholder and fail its
    //    own content-length check). This is also what gets each device's
    //    sharing_public_key onto its devices row - recordDeviceSeen() no-ops
    //    for an unclaimed mac, so there was no earlier point where the
    //    Worker could have learned it.
    await assertNoBucketScreen("ee02", bootNoBucket("ee02", "boot2-no-bucket"));
    await assertNoBucketScreen("ee04", bootNoBucket("ee04", "boot2-no-bucket"));

    const devices = await admin.listDevices();
    const ee02Device = devices.find((d) => d.mac === ee02Claim.mac);
    const ee04Device = devices.find((d) => d.mac === ee04Claim.mac);
    expect(ee02Device?.sharing_public_key, "EE02 device should have self-reported its sharing key by now").toBeTruthy();
    expect(ee04Device?.sharing_public_key, "EE04 device should have self-reported its sharing key by now").toBeTruthy();

    // 4. Create ONE bucket (not board-scoped - migrations/
    //    0019_image_board_variants.sql), upload ONE distinctive test image
    //    with BOTH boards' packed variants, and assign that SAME bucket to
    //    BOTH devices - using the real client-side crypto (bucket key
    //    generation, ECIES wrapping) an admin's browser would run.
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);

    const ownerKeyPair = await generateP256KeyPair();
    const wrappedForOwner = await wrapKeyFor(
      await exportPublicKeyRaw(ownerKeyPair.publicKey),
      bucketKeyRaw,
      HKDF_INFO_BUCKET_WRAP
    );
    const { id: bucketId } = await admin.createBucket("e2e-shared-bucket", wrappedForOwner);

    const ee02Image = buildTestPackedImage();
    const ee04Image = buildEe04TestPackedImage();
    // Any 16-hex string works as the keyed content hash — the Worker can't
    // verify it (it never sees plaintext), it only compares equal values.
    const CONTENT_HASH = "0123456789abcdef";
    const rawCiphertext = await aesGcmEncryptBlob(bucketKey, buildDummyBlob("raw"));
    const uploadVariants = {
      "ee02-13in3": { packedHash: ee02Image.packedHash, packed: await aesGcmEncryptBlob(bucketKey, ee02Image.packed), thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb-ee02")) },
      "ee04-7in3": { packedHash: ee04Image.packedHash, packed: await aesGcmEncryptBlob(bucketKey, ee04Image.packed), thumb: await aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb-ee04")) },
    };
    await admin.uploadImage(bucketId, "e2e-test.bin", { raw: rawCiphertext, variants: uploadVariants, contentHash: CONTENT_HASH });

    //    Duplicate detection (migrations/0020_image_content_hash.sql): a
    //    second FILENAME carrying the same content hash is rejected 409 and
    //    names the existing image; ?allow_duplicate=1 bypasses it. The forced
    //    duplicate is deleted right after so the single-image rotation
    //    assertions below stay single-image (no device fetch happens in
    //    between, so the rotation cursor is untouched).
    const dupeRes = await admin.uploadImageRaw(bucketId, "e2e-duplicate.bin", {
      raw: rawCiphertext,
      variants: uploadVariants,
      contentHash: CONTENT_HASH,
    });
    expect(dupeRes.status, "same-rendition re-upload under a new filename should be rejected").toBe(409);
    expect(((await dupeRes.json()) as { duplicate_of?: string }).duplicate_of).toBe("e2e-test.bin");

    await admin.uploadImage(bucketId, "e2e-duplicate.bin", {
      raw: rawCiphertext,
      variants: uploadVariants,
      contentHash: CONTENT_HASH,
      allowDuplicate: true,
    });
    const dupRow = (await admin.listImages(bucketId)).find((i) => i.filename === "e2e-duplicate.bin");
    expect(dupRow, "allow_duplicate=1 upload should have landed").toBeTruthy();
    await admin.deleteImage(dupRow!.id);

    const ee02DevicePublicKeyRaw = fromBase64(ee02Device!.sharing_public_key!);
    const ee04DevicePublicKeyRaw = fromBase64(ee04Device!.sharing_public_key!);
    await admin.assignBucketToDevice(ee02Claim.mac, bucketId, await wrapKeyFor(ee02DevicePublicKeyRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP));
    await admin.assignBucketToDevice(ee04Claim.mac, bucketId, await wrapKeyFor(ee04DevicePublicKeyRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP));

    // 5. Third boot each: both devices should now unwrap the SAME bucket
    //    key from /device_config, decrypt /image_packed, and display THEIR
    //    OWN board's rendition of the one uploaded image - top half black,
    //    bottom half red - with no content-length rejection for either.
    await assertDisplaysUploadedImage("ee02", "boot3-image", ee02Image.packedHash);
    await assertDisplaysUploadedImage("ee04", "boot3-image", ee04Image.packedHash);

    // 6. Fourth boot each: still the same single image in the same bucket -
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
    await assertDisplaysUploadedImage("ee02", "boot4-still-image", ee02Image.packedHash);
    await assertDisplaysUploadedImage("ee04", "boot4-still-image", ee04Image.packedHash);

    // 7. Server-scheduled quiet hours (the real product path: an override
    //    written by PUT /admin/schedule, served via /device_config, applied
    //    by the firmware before its image fetch). The active window is
    //    exactly one hour, two hours ahead of device-local now (the
    //    simulator's compiled-in tz offset is -360 minutes), so the current
    //    hour can never be inside it — even crossing an hour boundary
    //    between the hour computation and the boot leaves an hour of
    //    margin. This replaces the harness's active-window pin via
    //    activeWindow: null, which is the whole point: the SCHEDULE decides,
    //    not the wall clock (before that pin existed, this exact scenario
    //    made the whole suite time-of-day flaky).
    const DEVICE_TZ_MINUTES = -360; // simulator's DEFAULT_TIMEZONE_OFFSET_MINUTES
    const localHour = (new Date().getUTCHours() + DEVICE_TZ_MINUTES / 60 + 24) % 24;
    await admin.setSchedule(ee02Claim.mac, {
      refresh_interval_minutes: 60,
      active_start_hour: (localHour + 2) % 24,
      active_end_hour: (localHour + 3) % 24,
      timezone_offset_minutes: DEVICE_TZ_MINUTES,
    });

    const quietBoot = runSimulatorOnce({
      board: "ee02",
      server: wrangler.baseUrl,
      exportPath: path.join(workDir, "ee02-boot5-quiet.jpg"),
      activeWindow: null, // no pin — the server's schedule drives this boot
    });
    expect(quietBoot.stdout, "quiet-hours boot must defer the image fetch").toContain("Currently in quiet hours - skipping image fetch");
    expect(quietBoot.stdout, "quiet-hours boot must still sync config/time first").toContain("Remote config source:");
    expect(quietBoot.exportedJpegPaths, "nothing may be rendered during quiet hours").toHaveLength(0);

    //    The rotation cursor must be untouched: the image is still pending,
    //    nothing has been served or skipped past.
    const currentAfterQuiet = await admin.getCurrent(ee02Claim.mac);
    expect(currentAfterQuiet.total_images).toBe(1);
    expect(currentAfterQuiet.pending_image).toBe("e2e-test.bin");

    //    Positive control — same device, SAME image, server schedule flipped
    //    to always-active (start == end means "always active" per
    //    device_app.h's isWithinActiveWindow): the image now displays. This
    //    proves the quiet boot above deferred the fetch because of the
    //    schedule, not because something else was broken (decode, keys,
    //    rotation). Also proves the cursor resumed exactly where it was.
    await admin.setSchedule(ee02Claim.mac, {
      refresh_interval_minutes: 60,
      active_start_hour: 12,
      active_end_hour: 12,
      timezone_offset_minutes: DEVICE_TZ_MINUTES,
    });
    await assertDisplaysUploadedImage("ee02", "boot6-quiet-resume", ee02Image.packedHash, { activeWindow: null });

    // 8. Deleting the bucket must actually succeed - a bucket with an image
    //    that has variant rows for both boards (migrations/
    //    0019_image_board_variants.sql) previously tripped a FOREIGN KEY
    //    constraint failure, because DELETE /admin/buckets/:id deleted the
    //    images row before its image_variants children.
    await admin.deleteBucket(bucketId);
    expect((await admin.getBuckets()).find((b) => b.id === bucketId)).toBeUndefined();
  });
});
