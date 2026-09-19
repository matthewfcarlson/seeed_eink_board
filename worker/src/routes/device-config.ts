import type { Hono } from "hono";
import { DEFAULT_DEVICE_KEY, type Env } from "../types";
import { normalizeMac } from "../lib/mac";
import { recordDeviceSeen, resolveDeviceKey } from "../lib/auth-device";
import { verifyDeviceSignature } from "../lib/device-signature";
import { resolveScheduleConfig } from "../lib/schedule";
import { resolveFirmwareTarget } from "../lib/firmware-target";
import { getBucketKeysForDevice } from "../lib/bucket-keys";
import { isValidFirmwareVersion, isValidMac, isValidP256PublicKeyB64 } from "../lib/validate";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "../lib/rate-limit";

/**
 * GET /device_config — contract-critical (firmware/lib/common/device_app.h's
 * syncRemoteConfigAndTime()). MUST always include server_time_epoch; schedule
 * fields are omitted (not null) when unset, matching image_server.py's
 * dict.update() semantics — ArduinoJson treats missing keys as "leave current
 * value," so an explicit null would be wrong here.
 *
 * firmware_version/firmware_sha256 are likewise omitted (not null) unless the
 * device is on the 'stable' channel (see lib/firmware-target.ts) — no
 * admin-picked exact version anymore, just a channel choice. No channel ever
 * set (or 'beta', which has no pipeline yet) means "never touch this
 * device's firmware."
 *
 * Firmware resolution uses THIS REQUEST's X-Device-Board header directly, not
 * a devices.board read-back — avoids any staleness/bootstrap-ordering issue on
 * a device's very first request (recordDeviceSeen's write below is
 * fire-and-forget and may not have landed yet by the time this same request
 * needs the value). A request with no X-Device-Board (only possible from
 * firmware older than this) just gets no firmware fields — fails safe, same
 * as "no channel set."
 */
export function registerDeviceConfigRoute(app: Hono<{ Bindings: Env }>) {
  app.get("/device_config", async (c) => {
    const macHeader = c.req.header("X-Device-MAC");
    const batteryHeader = c.req.header("X-Battery-Voltage");
    // Sane LiPo/USB range (CLAUDE.md: 3.0V empty - 4.2V full, USB can read
    // higher) — bounds what a misbehaving sender can write into the column
    // /admin's device table renders.
    const parsedBattery = batteryHeader ? Number.parseFloat(batteryHeader) : NaN;
    const battery = Number.isFinite(parsedBattery) && parsedBattery > 0 && parsedBattery < 100 ? parsedBattery : NaN;
    const reportedFirmwareVersionRaw = c.req.header("X-Firmware-Version") ?? null;
    // Same bound as firmware_releases.version (lib/validate.ts) — bounded string
    // into devices.running_firmware_version, echoed nowhere except /admin.
    const reportedFirmwareVersion =
      reportedFirmwareVersionRaw && isValidFirmwareVersion(reportedFirmwareVersionRaw) ? reportedFirmwareVersionRaw : null;
    const reportedBoard = c.req.header("X-Device-Board") ?? null;
    // Base64, raw uncompressed P-256 point — generated on-device on first boot
    // (see device_app.h's ensureSharingKeyPair()) and self-reported the same
    // way as X-Device-Board, not pushed through a separate provisioning flow.
    // Validated against the wire format before it can land in
    // devices.sharing_public_key — the whole bucket-key-wrap flow keyranges off
    // this column, so junk must never be persisted from a stray header.
    const reportedSharingPublicKeyRaw = c.req.header("X-Device-Sharing-Public-Key") ?? null;
    const reportedSharingPublicKey =
      reportedSharingPublicKeyRaw && isValidP256PublicKeyB64(reportedSharingPublicKeyRaw) ? reportedSharingPublicKeyRaw : null;
    const ip = c.req.header("CF-Connecting-IP") ?? null;

    let deviceKey: string = DEFAULT_DEVICE_KEY;
    if (macHeader) {
      const mac = normalizeMac(macHeader);
      // Real firmware always sends its 6-byte MAC (12 hex chars after
      // normalizeMac); anything else can't be a device, so don't even look it
      // up — much less render it into the registration QR like an unregistered
      // MAC would get.
      if (!isValidMac(mac)) return c.text("X-Device-MAC header is not a valid MAC address", 400);
      if (!(await checkRateLimit(c.env, "device", mac, RATE_LIMITS.device.limit, RATE_LIMITS.device.windowSeconds))) {
        return rateLimitedResponse(RATE_LIMITS.device.windowSeconds);
      }
      const lookup = await resolveDeviceKey(c.env, mac);
      deviceKey = lookup.deviceKey;

      if (deviceKey !== DEFAULT_DEVICE_KEY) {
        const valid = await verifyDeviceSignature(
          c.env,
          mac,
          lookup.secret!,
          "/device_config",
          c.req.header("X-Device-Nonce"),
          c.req.header("X-Device-Signature")
        );
        if (!valid) return c.text("Invalid or missing device signature", 401);
      }

      // Fire-and-forget: last-seen/battery tracking must never delay the response.
      // No-ops for unregistered MACs (no devices row to update) — matches Python's
      // in-memory tracking being effectively per-known-device only in practice.
      c.executionCtx.waitUntil(
        recordDeviceSeen(
          c.env,
          mac,
          ip,
          Number.isNaN(battery) ? null : battery,
          reportedFirmwareVersion,
          reportedBoard,
          reportedSharingPublicKey
        )
      );
    }

    const { config, source } = await resolveScheduleConfig(c.env, deviceKey);
    const resolvedFirmware = reportedBoard ? await resolveFirmwareTarget(c.env, deviceKey, reportedBoard) : null;

    const firmware: { firmware_version: string; firmware_sha256: string } | Record<string, never> = resolvedFirmware
      ? { firmware_version: resolvedFirmware.version, firmware_sha256: resolvedFirmware.sha256 }
      : {};

    // Wrapped bucket keys this device already has an assignment for — see
    // device_app.h's fetchAndDisplayImage(), which unwraps each via its own
    // on-device P-256 private key (ECDH + HKDF + AES-GCM) before it can
    // decrypt anything from /image_packed. Omitted (not an empty array) for
    // an unregistered device, same "omit rather than send a meaningless
    // value" convention as the schedule/firmware fields above.
    const bucketKeys =
      deviceKey !== DEFAULT_DEVICE_KEY
        ? (await getBucketKeysForDevice(c.env, deviceKey)).map((k) => ({
            bucket_id: k.bucketId,
            // Which key version this wrap is for (see
            // migrations/0016_bucket_key_rotation.sql) — a device mid-rotation
            // can have two entries for the same bucket_id, one per version;
            // /image_packed's X-Bucket-Key-Version header says which to use.
            key_version: k.keyVersion,
            ephemeral_pub: k.ephemeralPub,
            nonce: k.nonce,
            ciphertext: k.ciphertext,
          }))
        : undefined;

    return c.json({
      device_id: deviceKey,
      server_time_epoch: Math.floor(Date.now() / 1000),
      config_source: source,
      ...config,
      ...firmware,
      ...(bucketKeys ? { bucket_keys: bucketKeys } : {}),
    });
  });
}
