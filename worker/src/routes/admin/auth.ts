import type { Hono } from "hono";
import type { Env } from "../../types";
import { requireAdmin } from "../../lib/admin-middleware";
import { CHALLENGE_TTL_SECONDS, isValidWrappedPrivateKeyFields, readSharingKeyWrap, type SharingKeyWrap } from "../../lib/webauthn";
import { verifySharingKeyProof, type SharingKeyProofPurpose } from "../../lib/sharing-key-proof";
import { kvKeys } from "../../lib/kv-keys";

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

interface StoredSharingKeyChallenge {
  user_id: string;
  server_private_key_pkcs8: string; // base64
}

/** Consumes (single-use) a challenge minted by POST /admin/me/sharing-key/challenge
 *  and checks the caller's proof that it holds the private half of the
 *  account's registered sharing_public_key — see lib/sharing-key-proof.ts.
 *  Returns false for an unknown/expired/foreign challenge, an account with no
 *  sharing key yet, or a bad proof. */
async function consumeSharingKeyProof(
  env: Env,
  userId: string,
  challengeId: unknown,
  proofB64: unknown,
  purpose: SharingKeyProofPurpose
): Promise<boolean> {
  if (typeof challengeId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(challengeId)) return false;
  if (typeof proofB64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(proofB64)) return false;
  const stored = await env.KV.get<StoredSharingKeyChallenge>(kvKeys.sharingKeyChallenge(challengeId), "json");
  if (!stored || stored.user_id !== userId) return false;
  // Delete before verifying so a wrong guess burns the challenge too.
  await env.KV.delete(kvKeys.sharingKeyChallenge(challengeId));
  const row = await env.DB.prepare("SELECT sharing_public_key FROM users WHERE id = ?")
    .bind(userId)
    .first<{ sharing_public_key: string | null }>();
  if (!row?.sharing_public_key) return false;
  const serverPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    b64ToBytes(stored.server_private_key_pkcs8),
    ECDH_P256,
    false,
    ["deriveBits"]
  );
  return verifySharingKeyProof(serverPrivateKey, b64ToBytes(row.sharing_public_key), challengeId, purpose, b64ToBytes(proofB64));
}

export function registerAdminAuthRoutes(app: Hono<{ Bindings: Env }>) {
  // Lets the admin UI verify a pasted API key / minted session is still valid.
  app.get("/admin/me", requireAdmin, async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT display_name, sharing_public_key, recovery_wrapped_sharing_key IS NOT NULL AS has_recovery_code FROM users WHERE id = ?"
    )
      .bind(c.var.user.id)
      .first<{ display_name: string | null; sharing_public_key: string | null; has_recovery_code: number }>();
    // is_superuser: from the token already resolved by requireAdmin, not a
    // second query — lets the client conditionally show the "Public bucket"
    // checkbox (see root CLAUDE.md's public-buckets plan / migrations/0018).
    // sharing_public_key: the account's P-256 sharing public key, so a caller
    // holding only the API key (scripts/upload-images.mjs) can ECIES-wrap a
    // new bucket's content key for this account exactly like the dashboard's
    // browser does (client/crypto.ts's wrapKeyFor) — without it, a bucket
    // created by the script would have no key row and be unrecoverable. The
    // public half is not sensitive (it's what every invite/device wrap
    // targets anyway); null until the account's first passkey login.
    return c.json({
      id: c.var.user.id,
      display_name: row?.display_name ?? null,
      is_superuser: c.var.user.is_superuser,
      sharing_public_key: row?.sharing_public_key ?? null,
      // Drives the admin UI's "create a recovery code" nudge (migrations/0025).
      has_recovery_code: !!row?.has_recovery_code,
    });
  });

  app.patch("/admin/me", requireAdmin, async (c) => {
    const body = await c.req.json<{ display_name?: string }>().catch(() => ({}) as never);
    const displayName = body.display_name?.trim();
    if (!displayName || displayName.length > 40) {
      return c.json({ error: "display_name is required and must be 1-40 characters" }, 400);
    }
    await c.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, c.var.user.id).run();
    // Echo is_superuser back too (from the token, unaffected by this update) so
    // admin.ts's `currentUser = await apiFetch(...)` doesn't lose the flag it
    // needs for the public-bucket checkbox after an Edit name round-trip.
    return c.json({ id: c.var.user.id, display_name: displayName, is_superuser: c.var.user.is_superuser });
  });

  // Backfills a credential's PRF-wrapped sharing key outside the passkey
  // ceremony itself — see routes/auth-passkey.ts's /auth/login/verify comment
  // for why this can't just be a second field on that endpoint: its challenge
  // is single-use and already consumed by the time the client's own
  // WebAuthn/crypto code has finished deciding whether a backfill is needed.
  // Authenticated by the ordinary Bearer session token that same login just minted,
  // not by another passkey ceremony. Guarded by the same IS NULL checks as
  // before — a client that resends this on every login can't clobber an
  // already-established wrap for either column.
  app.patch("/admin/me/sharing-key", requireAdmin, async (c) => {
    const body = await c.req.json<{ credential_id?: string } & Partial<SharingKeyWrap>>().catch(() => ({}) as never);
    if (!body.credential_id) return c.json({ error: "credential_id is required" }, 400);
    const sharingKey = readSharingKeyWrap(body);
    if (!sharingKey) return c.json({ error: "sharing_public_key, wrapped_sharing_key, and wrap_nonce are required" }, 400);

    const cred = await c.env.DB.prepare("SELECT user_id FROM credentials WHERE id = ?")
      .bind(body.credential_id)
      .first<{ user_id: string }>();
    if (!cred || cred.user_id !== c.var.user.id) return c.json({ error: "Not found" }, 404);

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET sharing_public_key = ? WHERE id = ? AND sharing_public_key IS NULL").bind(
        sharingKey.sharing_public_key,
        c.var.user.id
      ),
      c.env.DB
        .prepare(
          "UPDATE credentials SET wrapped_sharing_key = ?, wrap_nonce = ? WHERE id = ? AND wrapped_sharing_key IS NULL"
        )
        .bind(sharingKey.wrapped_sharing_key, sharingKey.wrap_nonce, body.credential_id),
    ]);

    return c.json({ ok: true });
  });

  // Mints a single-use challenge for lib/sharing-key-proof.ts: a fresh
  // ephemeral P-256 keypair whose private half stays in KV (scoped to this
  // user) and whose public half the client ECDHs against with its sharing
  // private key. Consumed by the two "replace a wrap" endpoints below.
  app.post("/admin/me/sharing-key/challenge", requireAdmin, async (c) => {
    const keyPair = (await crypto.subtle.generateKey(ECDH_P256, true, ["deriveBits"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer);
    const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer);
    const challengeId = bytesToB64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, "-").replace(/\//g, "_");
    const stored: StoredSharingKeyChallenge = { user_id: c.var.user.id, server_private_key_pkcs8: bytesToB64(pkcs8) };
    await c.env.KV.put(kvKeys.sharingKeyChallenge(challengeId), JSON.stringify(stored), {
      expirationTtl: CHALLENGE_TTL_SECONDS,
    });
    return c.json({ challenge_id: challengeId, server_public_key: bytesToB64(publicRaw) });
  });

  // Replaces (not backfills — see PATCH above for that) a credential's PRF
  // wrap. For the case where a credential's stored wrap doesn't open with the
  // PRF output its authenticator now returns — seen with iCloud Keychain,
  // whose PRF result at create() differs from later get()s — but this browser
  // still holds the right key locally. The client re-wraps under the new
  // output and verifies it opens before sending. Requires a possession proof
  // so a stolen session token alone can't overwrite a working wrap with
  // garbage; the public key can't change here (that would fork the account's
  // identity — every bucket key is wrapped for the existing one).
  app.put("/admin/me/sharing-key/repair", requireAdmin, async (c) => {
    const body = await c.req
      .json<{ credential_id?: string; challenge_id?: string; proof?: string } & Partial<SharingKeyWrap>>()
      .catch(() => ({}) as never);
    if (!body.credential_id) return c.json({ error: "credential_id is required" }, 400);
    const sharingKey = readSharingKeyWrap(body);
    if (!sharingKey) return c.json({ error: "sharing_public_key, wrapped_sharing_key, and wrap_nonce are required" }, 400);

    const cred = await c.env.DB.prepare(
      "SELECT c.user_id, u.sharing_public_key FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.id = ?"
    )
      .bind(body.credential_id)
      .first<{ user_id: string; sharing_public_key: string | null }>();
    if (!cred || cred.user_id !== c.var.user.id) return c.json({ error: "Not found" }, 404);
    if (cred.sharing_public_key !== sharingKey.sharing_public_key) {
      return c.json({ error: "sharing_public_key doesn't match this account's registered key" }, 409);
    }
    if (!(await consumeSharingKeyProof(c.env, c.var.user.id, body.challenge_id, body.proof, "repair-credential-wrap"))) {
      return c.json({ error: "Invalid or expired sharing-key proof" }, 403);
    }

    await c.env.DB.prepare("UPDATE credentials SET wrapped_sharing_key = ?, wrap_nonce = ? WHERE id = ? AND user_id = ?")
      .bind(sharingKey.wrapped_sharing_key, sharingKey.wrap_nonce, body.credential_id, c.var.user.id)
      .run();
    return c.json({ ok: true });
  });

  // The account's recovery-code wrap (migrations/0025). Session-gated even
  // though it's ciphertext under a 160-bit random code — no reason to hand it
  // to anyone who isn't already logged in as this account.
  app.get("/admin/me/recovery-wrap", requireAdmin, async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT sharing_public_key, recovery_wrapped_sharing_key, recovery_wrap_nonce, recovery_created_at FROM users WHERE id = ?"
    )
      .bind(c.var.user.id)
      .first<{
        sharing_public_key: string | null;
        recovery_wrapped_sharing_key: string | null;
        recovery_wrap_nonce: string | null;
        recovery_created_at: number | null;
      }>();
    if (!row?.recovery_wrapped_sharing_key || !row.recovery_wrap_nonce) {
      return c.json({ error: "No recovery code has been set up for this account" }, 404);
    }
    return c.json({
      sharing_public_key: row.sharing_public_key,
      wrapped_sharing_key: row.recovery_wrapped_sharing_key,
      wrap_nonce: row.recovery_wrap_nonce,
      created_at: row.recovery_created_at,
    });
  });

  // Sets or replaces the recovery-code wrap. Replacing invalidates the old
  // code (its wrap is gone). Needs the same possession proof as /repair —
  // otherwise a stolen session token could overwrite the wrap with garbage
  // and silently break the code the user saved.
  app.put("/admin/me/recovery-wrap", requireAdmin, async (c) => {
    const body = await c.req
      .json<{ wrapped_sharing_key?: string; wrap_nonce?: string; challenge_id?: string; proof?: string }>()
      .catch(() => ({}) as never);
    if (!isValidWrappedPrivateKeyFields(body.wrapped_sharing_key, body.wrap_nonce)) {
      return c.json({ error: "wrapped_sharing_key and wrap_nonce are required" }, 400);
    }
    if (!(await consumeSharingKeyProof(c.env, c.var.user.id, body.challenge_id, body.proof, "set-recovery-wrap"))) {
      return c.json({ error: "Invalid or expired sharing-key proof" }, 403);
    }
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      "UPDATE users SET recovery_wrapped_sharing_key = ?, recovery_wrap_nonce = ?, recovery_created_at = ? WHERE id = ?"
    )
      .bind(body.wrapped_sharing_key, body.wrap_nonce, now, c.var.user.id)
      .run();
    return c.json({ ok: true, created_at: now });
  });

  // API-key rotation is gone: tokens are per-login sessions now (see
  // migrations/0023_user_sessions.sql), so "rotate" is replaced by
  // POST /admin/sessions/revoke-others (sign out other devices) plus
  // DELETE /admin/sessions/current (real logout) — see routes/admin/sessions.ts.
}
