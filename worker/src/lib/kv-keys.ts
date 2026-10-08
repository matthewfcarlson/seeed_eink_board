export const kvKeys = {
  // v2: DeviceLookup gained a `secret` field (see lib/device-signature.ts). Bumped
  // so pre-existing 24h-TTL cache entries in the old {deviceKey, userId} shape
  // (no `secret`) are never misread as "registered with an implicit secret" —
  // that caused resolveDeviceKey() to hand verifyDeviceSignature() an `undefined`
  // secret and throw. Old v1 entries are simply orphaned and expire on their own.
  device: (mac: string) => `device:v2:${mac}`,
  rotation: (deviceKey: string) => `rotation:${deviceKey}`,
  schedule: (target: string) => `schedule:${target}`,
  // Pending WebAuthn ceremonies, keyed by a random attempt id handed to the client
  // in the /options response and echoed back on /verify. There's no username to key
  // on — accounts have no email/handle, so login is "usernameless" (discoverable
  // credential) too. Short TTL (see lib/webauthn.ts) — these never need to outlive a
  // single browser round trip.
  passkeyAttempt: (attemptId: string) => `passkey_attempt:${attemptId}`,
  // Pending sharing-key possession challenges (lib/sharing-key-proof.ts) —
  // the server's ephemeral ECDH private key for one challenge, scoped to the
  // user that minted it. Single-use and short-lived like passkeyAttempt.
  sharingKeyChallenge: (challengeId: string) => `sharing_key_challenge:${challengeId}`,
  // One record per device per UTC day (YYYYMMDD), 365d TTL — lib/battery-history.ts.
  batteryDay: (mac: string, day: string) => `battery:v1:${mac}:${day}`,
  firmwareTarget: (target: string) => `firmware_target:${target}`,
  // Board-scoped: firmware_releases' key is (board, version), and a release
  // deliberately reuses the same version tag across boards (one shared
  // FIRMWARE_VERSION — see firmware/lib/common/version.h), so keying on
  // version alone would let one board's sync overwrite another's binary.
  firmwareBin: (board: string, version: string) => `firmware:bin:${board}:${version}`,
};
