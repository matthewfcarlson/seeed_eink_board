import { describe, expect, it } from "vitest";
import {
  aesGcmDecryptFromStrings,
  aesGcmEncryptToStrings,
  deriveKekFromPrf,
  deriveKekFromRecoveryCode,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  formatRecoveryCode,
  generateP256KeyPair,
  generateRecoveryCodeBytes,
  importPrivateKeyPkcs8,
  parseRecoveryCode,
  publicKeyRawFromPrivateKey,
} from "../../src/client/crypto";
import { computeSharingKeyProof, verifySharingKeyProof } from "../../src/lib/sharing-key-proof";

describe("recovery code format", () => {
  it("formats 20 bytes as RC1- plus eight groups of four", () => {
    const code = formatRecoveryCode(generateRecoveryCodeBytes());
    expect(code).toMatch(/^RC1(-[0-9A-HJKMNP-TV-Z]{4}){8}$/);
  });

  it("round-trips through parse for many random codes", () => {
    for (let i = 0; i < 200; i++) {
      const bytes = generateRecoveryCodeBytes();
      expect(parseRecoveryCode(formatRecoveryCode(bytes))).toEqual(bytes);
    }
  });

  it("round-trips the all-zero and all-0xff edge cases", () => {
    for (const fill of [0, 0xff]) {
      const bytes = new Uint8Array(20).fill(fill);
      expect(parseRecoveryCode(formatRecoveryCode(bytes))).toEqual(bytes);
    }
  });

  it("is lenient about case, spacing, dashes, the prefix, and look-alike letters", () => {
    const bytes = generateRecoveryCodeBytes();
    const code = formatRecoveryCode(bytes);
    const body = code.slice(4);
    expect(parseRecoveryCode(code.toLowerCase())).toEqual(bytes);
    expect(parseRecoveryCode(`  ${body.replace(/-/g, " ")}  `)).toEqual(bytes);
    expect(parseRecoveryCode(body.replace(/-/g, ""))).toEqual(bytes);
    expect(parseRecoveryCode(code.replace(/0/g, "O").replace(/1/g, "l"))).toEqual(bytes);
  });

  it("rejects wrong lengths and characters outside the alphabet", () => {
    const code = formatRecoveryCode(generateRecoveryCodeBytes());
    expect(parseRecoveryCode(code.slice(0, -1))).toBeNull();
    expect(parseRecoveryCode(code + "A")).toBeNull();
    expect(parseRecoveryCode(code.slice(0, -1) + "U")).toBeNull();
    expect(parseRecoveryCode("")).toBeNull();
  });
});

describe("deriveKekFromRecoveryCode", () => {
  it("unwraps what it wrapped, and a different code (or a PRF KEK) can't", async () => {
    const codeBytes = generateRecoveryCodeBytes();
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const { nonce, ciphertext } = await aesGcmEncryptToStrings(await deriveKekFromRecoveryCode(codeBytes), plaintext);

    const reparsed = parseRecoveryCode(formatRecoveryCode(codeBytes))!;
    expect(await aesGcmDecryptFromStrings(await deriveKekFromRecoveryCode(reparsed), nonce, ciphertext)).toEqual(plaintext);

    const other = await deriveKekFromRecoveryCode(generateRecoveryCodeBytes());
    await expect(aesGcmDecryptFromStrings(other, nonce, ciphertext)).rejects.toThrow();
    // Domain separation: same bytes as a PRF output derive a different KEK.
    const asPrf = await deriveKekFromPrf(new Uint8Array(codeBytes).buffer);
    await expect(aesGcmDecryptFromStrings(asPrf, nonce, ciphertext)).rejects.toThrow();
  });
});

describe("sharing-key possession proof", () => {
  it("verifies for the real key holder, and only for that challenge + purpose", async () => {
    const sharing = await generateP256KeyPair();
    const server = await generateP256KeyPair();
    const sharingPub = await exportPublicKeyRaw(sharing.publicKey);
    const serverPub = await exportPublicKeyRaw(server.publicKey);

    const proof = await computeSharingKeyProof(sharing.privateKey, serverPub, "challenge-abc", "set-recovery-wrap");
    expect(await verifySharingKeyProof(server.privateKey, sharingPub, "challenge-abc", "set-recovery-wrap", proof)).toBe(true);
    expect(await verifySharingKeyProof(server.privateKey, sharingPub, "challenge-xyz", "set-recovery-wrap", proof)).toBe(false);
    expect(await verifySharingKeyProof(server.privateKey, sharingPub, "challenge-abc", "repair-credential-wrap", proof)).toBe(false);
  });

  it("fails for a different private key than the registered public key", async () => {
    const registered = await generateP256KeyPair();
    const imposter = await generateP256KeyPair();
    const server = await generateP256KeyPair();
    const proof = await computeSharingKeyProof(
      imposter.privateKey,
      await exportPublicKeyRaw(server.publicKey),
      "c",
      "repair-credential-wrap"
    );
    expect(
      await verifySharingKeyProof(server.privateKey, await exportPublicKeyRaw(registered.publicKey), "c", "repair-credential-wrap", proof)
    ).toBe(false);
  });

  it("returns false (doesn't throw) for a malformed registered public key", async () => {
    const server = await generateP256KeyPair();
    expect(await verifySharingKeyProof(server.privateKey, new Uint8Array(65), "c", "set-recovery-wrap", new Uint8Array(32))).toBe(false);
  });
});

describe("publicKeyRawFromPrivateKey", () => {
  it("matches the keypair's exported public key", async () => {
    const pair = await generateP256KeyPair();
    const reimported = await importPrivateKeyPkcs8(await exportPrivateKeyPkcs8(pair.privateKey));
    expect(await publicKeyRawFromPrivateKey(reimported)).toEqual(await exportPublicKeyRaw(pair.publicKey));
  });
});
