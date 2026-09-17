import { describe, expect, it } from "vitest";
import {
  HKDF_INFO_BUCKET_WRAP,
  HKDF_INFO_SHARING_KEY_WRAP,
  aesGcmDecryptBlob,
  aesGcmDecryptFromStrings,
  aesGcmEncryptBlob,
  aesGcmEncryptToStrings,
  deriveKekFromPrf,
  exportAesKeyRaw,
  exportPublicKeyRaw,
  fromBase64,
  fromBase64Url,
  generateBucketKey,
  generateP256KeyPair,
  importAesKeyRaw,
  importPublicKeyRaw,
  toBase64,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyFor,
} from "../../src/client/crypto";

describe("base64 round trip", () => {
  it("recovers arbitrary bytes, including 0x00 and 0xff", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 17]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe("base64url round trip", () => {
  it("recovers arbitrary bytes without padding characters", () => {
    for (let len = 0; len < 8; len++) {
      const bytes = new Uint8Array(len).map((_, i) => i * 37 + 1);
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(fromBase64Url(encoded)).toEqual(bytes);
    }
  });
});

describe("aesGcmEncryptToStrings / aesGcmDecryptFromStrings", () => {
  it("round-trips via separate nonce/ciphertext fields", async () => {
    const key = await generateBucketKey();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const { nonce, ciphertext } = await aesGcmEncryptToStrings(key, plaintext);
    expect(await aesGcmDecryptFromStrings(key, nonce, ciphertext)).toEqual(plaintext);
  });
});

describe("deriveKekFromPrf", () => {
  it("is deterministic for the same PRF output and can wrap/unwrap a key", async () => {
    const prfOutput = new Uint8Array(32).fill(9).buffer;
    const kekA = await deriveKekFromPrf(prfOutput);
    const kekB = await deriveKekFromPrf(prfOutput);
    const plaintext = new Uint8Array([42, 42, 42]);
    const { nonce, ciphertext } = await aesGcmEncryptToStrings(kekA, plaintext);
    expect(await aesGcmDecryptFromStrings(kekB, nonce, ciphertext)).toEqual(plaintext);
  });

  it("produces an unrelated key for different PRF output", async () => {
    const kekA = await deriveKekFromPrf(new Uint8Array(32).fill(1).buffer);
    const kekB = await deriveKekFromPrf(new Uint8Array(32).fill(2).buffer);
    const { nonce, ciphertext } = await aesGcmEncryptToStrings(kekA, new Uint8Array([1]));
    await expect(aesGcmDecryptFromStrings(kekB, nonce, ciphertext)).rejects.toThrow();
  });
});

describe("P-256 raw public key export/import", () => {
  it("round-trips through raw bytes", async () => {
    const pair = await generateP256KeyPair();
    const raw = await exportPublicKeyRaw(pair.publicKey);
    expect(raw.byteLength).toBe(65); // uncompressed point: 0x04 || X(32) || Y(32)
    const imported = await importPublicKeyRaw(raw);
    expect(imported.type).toBe("public");
    expect(imported.algorithm).toMatchObject({ name: "ECDH", namedCurve: "P-256" });
  });
});

describe("AES-256-GCM blob encrypt/decrypt", () => {
  it("round-trips plaintext", async () => {
    const key = await generateBucketKey();
    const plaintext = new Uint8Array(1000).map((_, i) => i % 256);
    const blob = await aesGcmEncryptBlob(key, plaintext);
    // nonce (12 bytes) + ciphertext + 16-byte GCM tag
    expect(blob.byteLength).toBe(12 + plaintext.byteLength + 16);
    const decrypted = await aesGcmDecryptBlob(key, blob);
    expect(decrypted).toEqual(plaintext);
  });

  it("uses a fresh nonce per call, so encrypting the same plaintext twice differs", async () => {
    const key = await generateBucketKey();
    const plaintext = new Uint8Array([1, 2, 3]);
    const a = await aesGcmEncryptBlob(key, plaintext);
    const b = await aesGcmEncryptBlob(key, plaintext);
    expect(a).not.toEqual(b);
  });

  it("rejects a tampered ciphertext instead of returning corrupted plaintext", async () => {
    const key = await generateBucketKey();
    const blob = await aesGcmEncryptBlob(key, new Uint8Array([9, 9, 9]));
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff; // flip a bit in the GCM tag
    await expect(aesGcmDecryptBlob(key, tampered)).rejects.toThrow();
  });

  it("raw key export/import round-trips to the same key material", async () => {
    const key = await generateBucketKey();
    const raw = await exportAesKeyRaw(key);
    const reimported = await importAesKeyRaw(raw);
    const plaintext = new Uint8Array([42]);
    const blob = await aesGcmEncryptBlob(key, plaintext);
    expect(await aesGcmDecryptBlob(reimported, blob)).toEqual(plaintext);
  });
});

describe("ECIES wrap/unwrap (wrapKeyFor / unwrapKeyWith)", () => {
  it("lets the recipient recover the wrapped key and no one else can", async () => {
    const recipient = await generateP256KeyPair();
    const recipientPubRaw = await exportPublicKeyRaw(recipient.publicKey);
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);

    const wrapped = await wrapKeyFor(recipientPubRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    const unwrapped = await unwrapKeyWith(recipient.privateKey, wrapped, HKDF_INFO_BUCKET_WRAP);
    expect(unwrapped).toEqual(bucketKeyRaw);

    // A different principal's private key must not be able to unwrap it.
    const other = await generateP256KeyPair();
    await expect(unwrapKeyWith(other.privateKey, wrapped, HKDF_INFO_BUCKET_WRAP)).rejects.toThrow();
  });

  it("fails closed when the HKDF info context doesn't match (domain separation)", async () => {
    const recipient = await generateP256KeyPair();
    const recipientPubRaw = await exportPublicKeyRaw(recipient.publicKey);
    const bucketKey = await generateBucketKey();
    const bucketKeyRaw = await exportAesKeyRaw(bucketKey);

    const wrapped = await wrapKeyFor(recipientPubRaw, bucketKeyRaw, HKDF_INFO_BUCKET_WRAP);
    await expect(unwrapKeyWith(recipient.privateKey, wrapped, HKDF_INFO_SHARING_KEY_WRAP)).rejects.toThrow();
  });

  it("produces a different ephemeral keypair (and ciphertext) on every call", async () => {
    const recipient = await generateP256KeyPair();
    const recipientPubRaw = await exportPublicKeyRaw(recipient.publicKey);
    const raw = new Uint8Array(32).fill(7);

    const a = await wrapKeyFor(recipientPubRaw, raw, HKDF_INFO_BUCKET_WRAP);
    const b = await wrapKeyFor(recipientPubRaw, raw, HKDF_INFO_BUCKET_WRAP);
    expect(a.ephemeralPub).not.toBe(b.ephemeralPub);
    expect(a.ciphertext).not.toBe(b.ciphertext);

    expect(await unwrapKeyWith(recipient.privateKey, a, HKDF_INFO_BUCKET_WRAP)).toEqual(raw);
    expect(await unwrapKeyWith(recipient.privateKey, b, HKDF_INFO_BUCKET_WRAP)).toEqual(raw);
  });
});
