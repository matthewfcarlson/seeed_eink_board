/**
 * Proof that a browser holds an account's sharing PRIVATE key, not just a
 * session token — required before the Worker lets a client overwrite
 * anything that only the key holder should be able to replace (a
 * credential's PRF wrap, the account's recovery-code wrap). The Worker can't
 * decrypt either wrap, so without this a stolen session token could swap in
 * garbage and quietly destroy the account's ability to unlock on new
 * browsers.
 *
 * Shape: the Worker mints an ephemeral P-256 keypair per challenge and hands
 * out the public half. The client does ECDH(sharing private key, server
 * ephemeral public) and the Worker does ECDH(server ephemeral private,
 * users.sharing_public_key) — the same shared secret only if the client
 * really holds the private key matching the account's registered public key.
 * That secret is HKDF'd into an HMAC key that MACs the challenge id and the
 * purpose. ECDH rather than ECDSA because the sharing key is an ECDH key
 * everywhere else — no reusing it across algorithms.
 *
 * Lives in lib/ (not client/) because both sides run it: plain WebCrypto,
 * identical in the Worker runtime and the browser.
 */

export const HKDF_INFO_SHARING_KEY_PROOF = "eink-sharing-key-proof-v1";

export type SharingKeyProofPurpose = "repair-credential-wrap" | "set-recovery-wrap";

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// The Workers runtime types spell ECDH's `public` field `$public` (a
// generator quirk) while DOM lib types use EcdhKeyDeriveParams; the runtime
// itself expects `public` in both. Cast once here so this module typechecks
// under either tsconfig.
function ecdhParams(peer: CryptoKey): Parameters<SubtleCrypto["deriveBits"]>[0] {
  return { name: "ECDH", public: peer } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
}

async function proofHmacKey(
  privateKey: CryptoKey,
  peerPublicKeyRaw: Uint8Array,
  usage: "sign" | "verify"
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey("raw", new Uint8Array(peerPublicKeyRaw), ECDH_P256, false, []);
  const shared = await crypto.subtle.deriveBits(ecdhParams(peer), privateKey, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO_SHARING_KEY_PROOF) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    [usage]
  );
}

function proofMessage(challengeId: string, purpose: SharingKeyProofPurpose): Uint8Array {
  return new TextEncoder().encode(`${purpose}:${challengeId}`);
}

/** Client side: MAC over (purpose, challenge id) under the ECDH-derived key. */
export async function computeSharingKeyProof(
  sharingPrivateKey: CryptoKey,
  serverPublicKeyRaw: Uint8Array,
  challengeId: string,
  purpose: SharingKeyProofPurpose
): Promise<Uint8Array> {
  const key = await proofHmacKey(sharingPrivateKey, serverPublicKeyRaw, "sign");
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(proofMessage(challengeId, purpose))));
}

/** Worker side: constant-time check (crypto.subtle.verify) of a client's proof. */
export async function verifySharingKeyProof(
  serverPrivateKey: CryptoKey,
  sharingPublicKeyRaw: Uint8Array,
  challengeId: string,
  purpose: SharingKeyProofPurpose,
  proof: Uint8Array
): Promise<boolean> {
  try {
    const key = await proofHmacKey(serverPrivateKey, sharingPublicKeyRaw, "verify");
    return await crypto.subtle.verify("HMAC", key, new Uint8Array(proof), new Uint8Array(proofMessage(challengeId, purpose)));
  } catch {
    // A malformed stored public key (shouldn't happen — readSharingKeyWrap
    // validates it on the way in) is a failed proof, not a 500.
    return false;
  }
}
