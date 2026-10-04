import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aesGcmDecryptFromStrings,
  aesGcmEncryptToStrings,
  deriveKekFromRecoveryCode,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  formatRecoveryCode,
  fromBase64,
  generateP256KeyPair,
  generateRecoveryCodeBytes,
  parseRecoveryCode,
  toBase64,
} from "../../src/client/crypto";
import { computeSharingKeyProof, type SharingKeyProofPurpose } from "../../src/lib/sharing-key-proof";
import { AdminClient } from "./lib/admin-client";
import { loginTestSessionWithWrap, registerTestAccount } from "./lib/virtual-authenticator";
import { startWranglerDev, type WranglerDevHandle } from "./lib/wrangler-dev";

/**
 * End-to-end coverage of the two "replace a wrap" paths added for browsers
 * that can't unlock via PRF (migrations/0025_recovery_code.sql,
 * routes/admin/auth.ts): the recovery-code wrap, and repairing a
 * credential's PRF wrap. Both require proof of holding the sharing private
 * key (lib/sharing-key-proof.ts) — a session token alone must not be enough.
 */
describe("e2e: sharing-key recovery code + wrap repair", () => {
  let wrangler: WranglerDevHandle;

  beforeAll(async () => {
    wrangler = await startWranglerDev({ port: 8797 });
  }, 60_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  async function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${wrangler.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  }

  async function prove(token: string, privateKey: CryptoKey, purpose: SharingKeyProofPurpose) {
    const res = await api(token, "/admin/me/sharing-key/challenge", { method: "POST" });
    expect(res.status).toBe(200);
    const { challenge_id, server_public_key } = (await res.json()) as { challenge_id: string; server_public_key: string };
    const proof = await computeSharingKeyProof(privateKey, fromBase64(server_public_key), challenge_id, purpose);
    return { challenge_id, proof: toBase64(proof) };
  }

  /** A registered account whose users.sharing_public_key is a real keypair this test holds. */
  async function accountWithSharingKey() {
    const { apiKey, credentialId } = await registerTestAccount(wrangler.baseUrl);
    const sharing = await generateP256KeyPair();
    const publicKeyB64 = toBase64(await exportPublicKeyRaw(sharing.publicKey));
    await new AdminClient(wrangler.baseUrl, apiKey).setSharingPublicKey(credentialId, publicKeyB64);
    return { apiKey, credentialId, sharing, publicKeyB64, pkcs8: await exportPrivateKeyPkcs8(sharing.privateKey) };
  }

  it("stores a recovery wrap only with a valid proof, and hands it back for unlocking", async () => {
    const { apiKey, sharing, pkcs8 } = await accountWithSharingKey();
    const me0 = (await (await api(apiKey, "/admin/me")).json()) as { has_recovery_code: boolean };
    expect(me0.has_recovery_code).toBe(false);
    expect((await api(apiKey, "/admin/me/recovery-wrap")).status).toBe(404);

    const code = formatRecoveryCode(generateRecoveryCodeBytes());
    const wrap = await aesGcmEncryptToStrings(await deriveKekFromRecoveryCode(parseRecoveryCode(code)!), pkcs8);
    const body = { wrapped_sharing_key: wrap.ciphertext, wrap_nonce: wrap.nonce };

    // No proof at all: rejected.
    expect((await api(apiKey, "/admin/me/recovery-wrap", { method: "PUT", body: JSON.stringify(body) })).status).toBe(403);

    // Proof from a key that isn't the account's: rejected.
    const imposter = await generateP256KeyPair();
    const badProof = await prove(apiKey, imposter.privateKey, "set-recovery-wrap");
    expect(
      (await api(apiKey, "/admin/me/recovery-wrap", { method: "PUT", body: JSON.stringify({ ...body, ...badProof }) })).status
    ).toBe(403);

    // Proof for the wrong purpose: rejected.
    const wrongPurpose = await prove(apiKey, sharing.privateKey, "repair-credential-wrap");
    expect(
      (await api(apiKey, "/admin/me/recovery-wrap", { method: "PUT", body: JSON.stringify({ ...body, ...wrongPurpose }) })).status
    ).toBe(403);

    // Real key holder: accepted, once.
    const goodProof = await prove(apiKey, sharing.privateKey, "set-recovery-wrap");
    const ok = await api(apiKey, "/admin/me/recovery-wrap", { method: "PUT", body: JSON.stringify({ ...body, ...goodProof }) });
    expect(ok.status).toBe(200);
    const replay = await api(apiKey, "/admin/me/recovery-wrap", { method: "PUT", body: JSON.stringify({ ...body, ...goodProof }) });
    expect(replay.status).toBe(403);

    const me1 = (await (await api(apiKey, "/admin/me")).json()) as { has_recovery_code: boolean };
    expect(me1.has_recovery_code).toBe(true);

    // A "new browser" (just the session) fetches the wrap and opens it with the pasted code.
    const fetched = (await (await api(apiKey, "/admin/me/recovery-wrap")).json()) as { wrapped_sharing_key: string; wrap_nonce: string };
    const kek = await deriveKekFromRecoveryCode(parseRecoveryCode(code.toLowerCase().replace(/-/g, " "))!);
    expect(await aesGcmDecryptFromStrings(kek, fetched.wrap_nonce, fetched.wrapped_sharing_key)).toEqual(pkcs8);
  });

  it("a challenge minted by one account can't be used by another", async () => {
    const a = await accountWithSharingKey();
    const b = await accountWithSharingKey();
    const code = generateRecoveryCodeBytes();
    const wrap = await aesGcmEncryptToStrings(await deriveKekFromRecoveryCode(code), b.pkcs8);
    // B computes a valid-looking proof over A's challenge.
    const challengeRes = await api(a.apiKey, "/admin/me/sharing-key/challenge", { method: "POST" });
    const { challenge_id, server_public_key } = (await challengeRes.json()) as { challenge_id: string; server_public_key: string };
    const proof = toBase64(await computeSharingKeyProof(b.sharing.privateKey, fromBase64(server_public_key), challenge_id, "set-recovery-wrap"));
    const res = await api(b.apiKey, "/admin/me/recovery-wrap", {
      method: "PUT",
      body: JSON.stringify({ wrapped_sharing_key: wrap.ciphertext, wrap_nonce: wrap.nonce, challenge_id, proof }),
    });
    expect(res.status).toBe(403);
  });

  it("repairs (overwrites) a credential's PRF wrap only with a valid proof and the same public key", async () => {
    const { apiKey, credentialId, sharing, publicKeyB64 } = await accountWithSharingKey();
    const before = await loginTestSessionWithWrap(wrangler.baseUrl, credentialId);
    expect(before.wrapped_sharing_key).toBeTruthy();

    const replacement = {
      credential_id: credentialId,
      sharing_public_key: publicKeyB64,
      wrap_nonce: Buffer.alloc(12, 7).toString("base64"),
      wrapped_sharing_key: Buffer.alloc(121, 7).toString("base64"),
    };

    // Session token alone: rejected, wrap unchanged.
    expect((await api(apiKey, "/admin/me/sharing-key/repair", { method: "PUT", body: JSON.stringify(replacement) })).status).toBe(403);
    expect((await loginTestSessionWithWrap(wrangler.baseUrl, credentialId)).wrapped_sharing_key).toEqual(before.wrapped_sharing_key);

    // Trying to swap in a different identity: rejected even with a valid proof.
    const other = await generateP256KeyPair();
    const forkProof = await prove(apiKey, sharing.privateKey, "repair-credential-wrap");
    const fork = await api(apiKey, "/admin/me/sharing-key/repair", {
      method: "PUT",
      body: JSON.stringify({ ...replacement, sharing_public_key: toBase64(await exportPublicKeyRaw(other.publicKey)), ...forkProof }),
    });
    expect(fork.status).toBe(409);

    // Real key holder: wrap replaced.
    const proof = await prove(apiKey, sharing.privateKey, "repair-credential-wrap");
    const ok = await api(apiKey, "/admin/me/sharing-key/repair", { method: "PUT", body: JSON.stringify({ ...replacement, ...proof }) });
    expect(ok.status).toBe(200);
    const after = await loginTestSessionWithWrap(wrangler.baseUrl, credentialId);
    expect(after.wrapped_sharing_key).toEqual(replacement.wrapped_sharing_key);
    expect(after.wrap_nonce).toEqual(replacement.wrap_nonce);
  });
});
