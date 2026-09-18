import { describe, expect, it } from "vitest";
import {
  MAX_BUCKET_LABEL,
  MAX_DEVICE_LABEL,
  MAX_FILENAME,
  isValidFirmwareVersion,
  isValidMac,
  isValidP256PublicKeyB64,
  isValidRawAesKeyB64,
  validateFilename,
  validateLabel,
} from "../../src/lib/validate";
import { parseWrappedBucketKey } from "../../src/lib/bucket-keys";
import { generateP256KeyPair, exportPublicKeyRaw, wrapKeyFor, generateBucketKey, exportAesKeyRaw, toBase64, HKDF_INFO_BUCKET_WRAP } from "../../src/client/crypto";

describe("validateLabel", () => {
  it("trims and accepts a normal label", () => {
    expect(validateLabel("  Kitchen  ", MAX_BUCKET_LABEL)).toBe("Kitchen");
  });

  it("rejects blank and non-string values", () => {
    expect(validateLabel("", MAX_BUCKET_LABEL)).toBeNull();
    expect(validateLabel("   ", MAX_BUCKET_LABEL)).toBeNull();
    expect(validateLabel(42, MAX_BUCKET_LABEL)).toBeNull();
    expect(validateLabel(undefined, MAX_BUCKET_LABEL)).toBeNull();
  });

  it("rejects over-limit labels", () => {
    expect(validateLabel("a".repeat(MAX_BUCKET_LABEL), MAX_BUCKET_LABEL)).toBe("a".repeat(MAX_BUCKET_LABEL));
    expect(validateLabel("a".repeat(MAX_BUCKET_LABEL + 1), MAX_BUCKET_LABEL)).toBeNull();
  });
});

describe("validateFilename", () => {
  it("accepts a normal filename", () => {
    expect(validateFilename("sunset.jpg")).toBe("sunset.jpg");
  });

  it("rejects empty, over-long, and control-character filenames", () => {
    expect(validateFilename("")).toBeNull();
    expect(validateFilename("a".repeat(MAX_FILENAME + 1))).toBeNull();
    expect(validateFilename("bad\nname.jpg")).toBeNull();
    expect(validateFilename("bad\rname.jpg")).toBeNull();
    expect(validateFilename("bad\u0000name.jpg")).toBeNull();
    expect(validateFilename(123)).toBeNull();
  });

  it("does not trim (filename is the unique catalog key)", () => {
    expect(validateFilename(" spaced.jpg ")).toBe(" spaced.jpg ");
  });
});

describe("isValidMac", () => {
  it("accepts normalized 12-hex MACs", () => {
    expect(isValidMac("aabbccddeeff")).toBe(true);
  });

  it("rejects junk", () => {
    expect(isValidMac("")).toBe(false);
    expect(isValidMac("aabbccddeef")).toBe(false);
    expect(isValidMac("aabbccddeeff0")).toBe(false);
    expect(isValidMac("zzbbccddeeff")).toBe(false);
    expect(isValidMac("aa:bb:cc:dd:ee:ff")).toBe(false); // must be normalized first
  });
});

describe("key format validators", () => {
  it("accepts a real exported P-256 public point", async () => {
    const kp = await generateP256KeyPair();
    const b64 = toBase64(await exportPublicKeyRaw(kp.publicKey));
    expect(b64.length).toBe(88);
    expect(isValidP256PublicKeyB64(b64)).toBe(true);
  });

  it("accepts a real raw AES-256 bucket key", async () => {
    const b64 = toBase64(await exportAesKeyRaw(await generateBucketKey()));
    expect(b64.length).toBe(44);
    expect(isValidRawAesKeyB64(b64)).toBe(true);
  });

  it("rejects wrong sizes and non-base64", () => {
    expect(isValidP256PublicKeyB64("tooshort")).toBe(false);
    // 44 chars of base64 alphabet WITHOUT padding decodes to 33 bytes, not a
    // 32-byte key — the trailing '=' is what pins the decoded length.
    expect(isValidRawAesKeyB64("a".repeat(44))).toBe(false);
    expect(isValidRawAesKeyB64("a".repeat(43) + "=")).toBe(true);
  });

  it("rejects truncated/non-string values", () => {
    expect(isValidP256PublicKeyB64(undefined)).toBe(false);
    expect(isValidP256PublicKeyB64(123)).toBe(false);
    expect(isValidRawAesKeyB64("!!!!")).toBe(false);
    expect(isValidFirmwareVersion("1.2.3")).toBe(true);
    expect(isValidFirmwareVersion("v1.2.3-beta.1+build")).toBe(true);
    expect(isValidFirmwareVersion("1.2.3\nEVIL")).toBe(false);
    expect(isValidFirmwareVersion("a".repeat(65))).toBe(false);
  });
});

describe("parseWrappedBucketKey (tightened)", () => {
  it("accepts a real ECIES-wrapped bucket key", async () => {
    const kp = await generateP256KeyPair();
    const raw = await exportAesKeyRaw(await generateBucketKey());
    const wrapped = await wrapKeyFor(await exportPublicKeyRaw(kp.publicKey), raw, HKDF_INFO_BUCKET_WRAP);
    expect(parseWrappedBucketKey(wrapped)).toEqual(wrapped);
  });

  it("rejects truncated fields (shape used to be enough)", () => {
    expect(parseWrappedBucketKey({ ephemeralPub: "short", nonce: "short", ciphertext: "short" })).toBeNull();
    expect(parseWrappedBucketKey({ ephemeralPub: "a".repeat(88), nonce: "a".repeat(16), ciphertext: "a".repeat(63) })).toBeNull();
    expect(parseWrappedBucketKey(null)).toBeNull();
    expect(parseWrappedBucketKey({ ephemeralPub: 1, nonce: "a".repeat(16), ciphertext: "a".repeat(64) })).toBeNull();
  });
});

describe("device label limit mirrors the API", () => {
  it("MAX_DEVICE_LABEL is 80", () => {
    expect(MAX_DEVICE_LABEL).toBe(80);
  });
});
