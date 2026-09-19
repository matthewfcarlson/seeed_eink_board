import type { Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Env } from "../types";
import { generateApiKey, hashApiKey } from "../lib/auth-admin";
import { kvKeys } from "../lib/kv-keys";
import {
  CHALLENGE_TTL_SECONDS,
  PRF_EXTENSION_INPUT,
  RP_NAME,
  readSharingKeyWrap,
  rpIdAndOrigin,
  type PendingLogin,
  type PendingRegistration,
  type SharingKeyWrap,
} from "../lib/webauthn";
import { checkRateLimit, rateLimitedResponse, RATE_LIMITS } from "../lib/rate-limit";

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  wrapped_sharing_key: string | null;
  wrap_nonce: string | null;
}

/**
 * Public (unauthenticated) passkey endpoints. These are the *only* way to create an
 * account — there's no email/username, no password, and no other signup path. A
 * passkey ceremony is the entire identity: the account is just a row keyed by a
 * generated id, proven by whoever holds the matching authenticator. Login is
 * "usernameless" too (resident/discoverable credential + OS account picker), so
 * there's nothing to type in either direction — just a button.
 *
 * Both endpoints mint a fresh API key on success, reusing the existing
 * Authorization: Bearer <api_key> model for the rest of /admin — a successful
 * ceremony is just another way to obtain one, same as the old bootstrap script.
 */
/** Per-IP limit shared by all four passkey endpoints. Keyed by the edge-reported
 *  client IP; "unknown" collapses anything header-less into one bucket, which is
 *  the correct conservative default. */
async function perIpLimit(c: { env: Env; req: { header(name: string): string | undefined } }): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  return checkRateLimit(c.env, "auth", ip, RATE_LIMITS.auth.limit, RATE_LIMITS.auth.windowSeconds);
}

export function registerAuthPasskeyRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/auth/register/options", async (c) => {
    if (!(await perIpLimit(c))) return rateLimitedResponse(RATE_LIMITS.auth.windowSeconds);
    const { rpID } = rpIdAndOrigin(c.req.url);
    const userId = crypto.randomUUID();

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: userId,
      userID: new TextEncoder().encode(userId).slice(),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      extensions: PRF_EXTENSION_INPUT,
    });

    const attemptId = crypto.randomUUID();
    const pending: PendingRegistration = { challenge: options.challenge, userId };
    await c.env.KV.put(kvKeys.passkeyAttempt(attemptId), JSON.stringify(pending), {
      expirationTtl: CHALLENGE_TTL_SECONDS,
    });

    return c.json({ attemptId, options });
  });

  app.post("/auth/register/verify", async (c) => {
    if (!(await perIpLimit(c))) return rateLimitedResponse(RATE_LIMITS.auth.windowSeconds);
    const body = await c.req
      .json<{ attemptId?: string; response?: RegistrationResponseJSON } & Partial<SharingKeyWrap>>()
      .catch(() => ({}) as never);
    if (!body.attemptId || !body.response) return c.json({ error: "attemptId and response are required" }, 400);
    // Present only if this ceremony's authenticator returned a PRF result at
    // creation time — some don't, and get a chance to backfill this on their
    // first real login instead (see /auth/login/verify below).
    const sharingKey = readSharingKeyWrap(body);

    const pendingRaw = await c.env.KV.get(kvKeys.passkeyAttempt(body.attemptId));
    if (!pendingRaw) return c.json({ error: "Registration expired or not found — try again" }, 400);
    const pending = JSON.parse(pendingRaw) as PendingRegistration;

    const { rpID, origin } = rpIdAndOrigin(c.req.url);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Verification failed" }, 400);
    }
    if (!verification.verified) return c.json({ error: "Passkey verification failed" }, 400);

    const { credential } = verification.registrationInfo;
    const apiKey = generateApiKey();
    const apiKeyHash = await hashApiKey(apiKey);
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, api_key_hash, created_at, sharing_public_key) VALUES (?, ?, ?, ?)").bind(
        pending.userId,
        apiKeyHash,
        now,
        sharingKey?.sharing_public_key ?? null
      ),
      c.env.DB.prepare(
        `INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at, wrapped_sharing_key, wrap_nonce)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        credential.id,
        pending.userId,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        now,
        sharingKey?.wrapped_sharing_key ?? null,
        sharingKey?.wrap_nonce ?? null
      ),
    ]);

    await c.env.KV.delete(kvKeys.passkeyAttempt(body.attemptId));
    return c.json({ api_key: apiKey }, 201);
  });

  app.post("/auth/login/options", async (c) => {
    if (!(await perIpLimit(c))) return rateLimitedResponse(RATE_LIMITS.auth.windowSeconds);
    const { rpID } = rpIdAndOrigin(c.req.url);

    // No allowCredentials — the browser shows its own picker over every resident
    // (discoverable) credential registered for this rpID, across accounts.
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
      extensions: PRF_EXTENSION_INPUT,
    });

    const attemptId = crypto.randomUUID();
    const pending: PendingLogin = { challenge: options.challenge };
    await c.env.KV.put(kvKeys.passkeyAttempt(attemptId), JSON.stringify(pending), {
      expirationTtl: CHALLENGE_TTL_SECONDS,
    });

    return c.json({ attemptId, options });
  });

  app.post("/auth/login/verify", async (c) => {
    if (!(await perIpLimit(c))) return rateLimitedResponse(RATE_LIMITS.auth.windowSeconds);
    const body = await c.req
      .json<{ attemptId?: string; response?: AuthenticationResponseJSON }>()
      .catch(() => ({}) as never);
    if (!body.attemptId || !body.response) return c.json({ error: "attemptId and response are required" }, 400);

    const pendingRaw = await c.env.KV.get(kvKeys.passkeyAttempt(body.attemptId));
    if (!pendingRaw) return c.json({ error: "Login expired or not found — try again" }, 400);
    const pending = JSON.parse(pendingRaw) as PendingLogin;

    // The credential id in the response tells us which account this is — that's
    // the whole point of a discoverable-credential/usernameless flow.
    const credRow = await c.env.DB.prepare(
      `SELECT credentials.*, users.sharing_public_key AS user_sharing_public_key
       FROM credentials JOIN users ON users.id = credentials.user_id
       WHERE credentials.id = ?`
    )
      .bind(body.response.id)
      .first<CredentialRow & { user_sharing_public_key: string | null }>();
    if (!credRow) return c.json({ error: "Unknown passkey" }, 400);

    const { rpID, origin } = rpIdAndOrigin(c.req.url);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: credRow.id,
          publicKey: isoBase64URL.toBuffer(credRow.public_key),
          counter: credRow.counter,
          transports: credRow.transports ? JSON.parse(credRow.transports) : undefined,
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Verification failed" }, 400);
    }
    if (!verification.verified) return c.json({ error: "Passkey verification failed" }, 400);

    // Mints a fresh API key on every login, same as the "Rotate API Key" admin
    // action — only the hash is stored so there's no way to hand back an old one.
    const apiKey = generateApiKey();
    const apiKeyHash = await hashApiKey(apiKey);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET api_key_hash = ? WHERE id = ?").bind(apiKeyHash, credRow.user_id),
      c.env.DB.prepare("UPDATE credentials SET counter = ? WHERE id = ?").bind(
        verification.authenticationInfo.newCounter,
        credRow.id
      ),
    ]);

    await c.env.KV.delete(kvKeys.passkeyAttempt(body.attemptId));

    // Whatever's currently on file for this credential — null means it has no
    // PRF-protected sharing key yet (never backfilled, or this authenticator
    // doesn't support PRF at all). Backfilling happens via a *separate*
    // authenticated call (PATCH /admin/me/sharing-key, using the api_key just
    // minted above), not here: this ceremony's challenge is single-use and
    // already consumed by the KV delete above, so there's no way to make a
    // second /auth/login/verify call with it if the client discovers only
    // after seeing this response that it needs to upload a wrap.
    return c.json({
      api_key: apiKey,
      sharing_public_key: credRow.user_sharing_public_key,
      wrapped_sharing_key: credRow.wrapped_sharing_key,
      wrap_nonce: credRow.wrap_nonce,
    });
  });
}
