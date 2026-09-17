import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { AuthenticationExtensionsClientInputs } from "@simplewebauthn/server";

export const RP_NAME = "E-Ink Frame Server";

/**
 * Requested on both registration and authentication ceremonies to obtain a
 * per-credential deterministic secret (the WebAuthn PRF extension) that
 * protects a user's sharing private key — see root CLAUDE.md's encrypted-
 * buckets plan and client/crypto.ts's deriveKekFromPrf(). The salt is not
 * secret; it only needs to be fixed so the same credential always yields the
 * same PRF output. @simplewebauthn/server's own bundled DOM type shim
 * predates the PRF extension (added in WebAuthn Level 3), hence the cast —
 * this still serializes to the exact JSON shape the browser's
 * parseCreationOptionsFromJSON/parseRequestOptionsFromJSON expect.
 */
const PRF_SALT = isoBase64URL.fromBuffer(new Uint8Array(new TextEncoder().encode("eink-pictureframe-prf-salt-v1")));
export const PRF_EXTENSION_INPUT = {
  prf: { eval: { first: PRF_SALT } },
} as AuthenticationExtensionsClientInputs;

/**
 * Optional on /auth/register/verify and PATCH /admin/me/sharing-key — present
 * iff the client's WebAuthn ceremony returned a usable PRF result (see
 * PRF_EXTENSION_INPUT above and client/crypto.ts's deriveKekFromPrf). All
 * three or none: the client wraps its sharing private key with the
 * PRF-derived KEK entirely locally and only ever uploads the already-wrapped
 * ciphertext, never the PRF output or the raw private key.
 */
export interface SharingKeyWrap {
  sharing_public_key: string;
  wrapped_sharing_key: string;
  wrap_nonce: string;
}

export function readSharingKeyWrap(body: Partial<SharingKeyWrap>): SharingKeyWrap | null {
  if (!body.sharing_public_key || !body.wrapped_sharing_key || !body.wrap_nonce) return null;
  return {
    sharing_public_key: body.sharing_public_key,
    wrapped_sharing_key: body.wrapped_sharing_key,
    wrap_nonce: body.wrap_nonce,
  };
}

// A ceremony (options -> browser prompt -> verify) should take a few seconds, not
// minutes; short TTL just bounds how long an abandoned attempt lingers in KV.
export const CHALLENGE_TTL_SECONDS = 300;

/** Derives WebAuthn rpID/origin from the incoming request so this works unmodified
 *  on workers.dev, a custom domain, or local `wrangler dev` — same trick as
 *  registrationUrl() uses for the device-claim link. */
export function rpIdAndOrigin(requestUrl: string): { rpID: string; origin: string } {
  const url = new URL(requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}

export interface PendingRegistration {
  challenge: string;
  userId: string;
}

// No userId yet — usernameless login doesn't know who's authenticating until the
// browser's discoverable-credential picker returns a response.
export interface PendingLogin {
  challenge: string;
}
