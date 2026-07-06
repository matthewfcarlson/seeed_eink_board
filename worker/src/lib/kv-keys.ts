export const kvKeys = {
  device: (mac: string) => `device:${mac}`,
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
