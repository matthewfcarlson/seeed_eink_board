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
  firmwareTarget: (target: string) => `firmware_target:${target}`,
  firmwareBin: (version: string) => `firmware:bin:${version}`,
};
