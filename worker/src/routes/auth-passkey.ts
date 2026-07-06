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
import { CHALLENGE_TTL_SECONDS, RP_NAME, rpIdAndOrigin, type PendingLogin, type PendingRegistration } from "../lib/webauthn";

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
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
export function registerAuthPasskeyRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/auth/register/options", async (c) => {
    const { rpID } = rpIdAndOrigin(c.req.url);
    const userId = crypto.randomUUID();

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: userId,
      userID: new TextEncoder().encode(userId).slice(),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });

    const attemptId = crypto.randomUUID();
    const pending: PendingRegistration = { challenge: options.challenge, userId };
    await c.env.KV.put(kvKeys.passkeyAttempt(attemptId), JSON.stringify(pending), {
      expirationTtl: CHALLENGE_TTL_SECONDS,
    });

    return c.json({ attemptId, options });
  });

  app.post("/auth/register/verify", async (c) => {
    const body = await c.req
      .json<{ attemptId?: string; response?: RegistrationResponseJSON }>()
      .catch(() => ({}) as never);
    if (!body.attemptId || !body.response) return c.json({ error: "attemptId and response are required" }, 400);

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
      c.env.DB.prepare("INSERT INTO users (id, api_key_hash, created_at) VALUES (?, ?, ?)").bind(
        pending.userId,
        apiKeyHash,
        now
      ),
      c.env.DB.prepare(
        "INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(
        credential.id,
        pending.userId,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        now
      ),
    ]);

    await c.env.KV.delete(kvKeys.passkeyAttempt(body.attemptId));
    return c.json({ api_key: apiKey }, 201);
  });

  app.post("/auth/login/options", async (c) => {
    const { rpID } = rpIdAndOrigin(c.req.url);

    // No allowCredentials — the browser shows its own picker over every resident
    // (discoverable) credential registered for this rpID, across accounts.
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });

    const attemptId = crypto.randomUUID();
    const pending: PendingLogin = { challenge: options.challenge };
    await c.env.KV.put(kvKeys.passkeyAttempt(attemptId), JSON.stringify(pending), {
      expirationTtl: CHALLENGE_TTL_SECONDS,
    });

    return c.json({ attemptId, options });
  });

  app.post("/auth/login/verify", async (c) => {
    const body = await c.req
      .json<{ attemptId?: string; response?: AuthenticationResponseJSON }>()
      .catch(() => ({}) as never);
    if (!body.attemptId || !body.response) return c.json({ error: "attemptId and response are required" }, 400);

    const pendingRaw = await c.env.KV.get(kvKeys.passkeyAttempt(body.attemptId));
    if (!pendingRaw) return c.json({ error: "Login expired or not found — try again" }, 400);
    const pending = JSON.parse(pendingRaw) as PendingLogin;

    // The credential id in the response tells us which account this is — that's
    // the whole point of a discoverable-credential/usernameless flow.
    const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE id = ?")
      .bind(body.response.id)
      .first<CredentialRow>();
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
    return c.json({ api_key: apiKey });
  });
}
