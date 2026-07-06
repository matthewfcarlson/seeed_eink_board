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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
}

/**
 * Public (unauthenticated) passkey endpoints. These are the *only* way to create an
 * account — there is no other signup path and the old bootstrap-user.mjs script
 * (raw SQL insert) has been removed. Returning users can also use these to mint a
 * fresh API key without having kept the old one around; login re-uses the same
 * Authorization: Bearer <api_key> model as the rest of /admin, it's just issued by
 * a passkey ceremony instead of a script.
 */
export function registerAuthPasskeyRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/auth/register/options", async (c) => {
    const body = await c.req.json<{ email?: string }>().catch(() => ({}) as never);
    const email = body.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return c.json({ error: "Valid email is required" }, 400);

    const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return c.json({ error: "An account with this email already exists" }, 409);

    const { rpID } = rpIdAndOrigin(c.req.url);
    const userId = crypto.randomUUID();

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: email,
      userID: new TextEncoder().encode(userId).slice(),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });

    const pending: PendingRegistration = { challenge: options.challenge, userId, email };
    await c.env.KV.put(kvKeys.passkeyRegistration(email), JSON.stringify(pending), {
      expirationTtl: CHALLENGE_TTL_SECONDS,
    });

    return c.json(options);
  });

  app.post("/auth/register/verify", async (c) => {
    const body = await c.req.json<{ email?: string; response?: RegistrationResponseJSON }>().catch(() => ({}) as never);
    const email = body.email?.trim().toLowerCase();
    if (!email || !body.response) return c.json({ error: "email and response are required" }, 400);

    const pendingRaw = await c.env.KV.get(kvKeys.passkeyRegistration(email));
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
      c.env.DB.prepare("INSERT INTO users (id, email, api_key_hash, created_at) VALUES (?, ?, ?, ?)").bind(
        pending.userId,
        email,
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

    await c.env.KV.delete(kvKeys.passkeyRegistration(email));
    return c.json({ email, api_key: apiKey }, 201);
  });

  app.post("/auth/login/options", async (c) => {
    const body = await c.req.json<{ email?: string }>().catch(() => ({}) as never);
    const email = body.email?.trim().toLowerCase();
    if (!email) return c.json({ error: "email is required" }, 400);

    const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    if (!user) return c.json({ error: "No account or passkey found for that email" }, 404);

    const credRows = await c.env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
      .bind(user.id)
      .all<{ id: string; transports: string | null }>();
    if (credRows.results.length === 0) {
      return c.json({ error: "No account or passkey found for that email" }, 404);
    }

    const { rpID } = rpIdAndOrigin(c.req.url);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credRows.results.map((row) => ({
        id: row.id,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      })),
      userVerification: "preferred",
    });

    const pending: PendingLogin = { challenge: options.challenge, userId: user.id };
    await c.env.KV.put(kvKeys.passkeyLogin(email), JSON.stringify(pending), { expirationTtl: CHALLENGE_TTL_SECONDS });

    return c.json(options);
  });

  app.post("/auth/login/verify", async (c) => {
    const body = await c.req.json<{ email?: string; response?: AuthenticationResponseJSON }>().catch(() => ({}) as never);
    const email = body.email?.trim().toLowerCase();
    if (!email || !body.response) return c.json({ error: "email and response are required" }, 400);

    const pendingRaw = await c.env.KV.get(kvKeys.passkeyLogin(email));
    if (!pendingRaw) return c.json({ error: "Login expired or not found — try again" }, 400);
    const pending = JSON.parse(pendingRaw) as PendingLogin;

    const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE id = ? AND user_id = ?")
      .bind(body.response.id, pending.userId)
      .first<CredentialRow>();
    if (!credRow) return c.json({ error: "Unknown passkey for this account" }, 400);

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
      c.env.DB.prepare("UPDATE users SET api_key_hash = ? WHERE id = ?").bind(apiKeyHash, pending.userId),
      c.env.DB.prepare("UPDATE credentials SET counter = ? WHERE id = ?").bind(
        verification.authenticationInfo.newCounter,
        credRow.id
      ),
    ]);

    await c.env.KV.delete(kvKeys.passkeyLogin(email));
    return c.json({ email, api_key: apiKey });
  });
}
