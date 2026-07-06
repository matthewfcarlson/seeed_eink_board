export const RP_NAME = "E-Ink Frame Server";

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
