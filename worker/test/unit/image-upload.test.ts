import { describe, expect, it } from "vitest";
import { readCiphertextUploadBytes, validateCiphertextUploadFields } from "../../src/lib/image-upload";

function file(bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], "blob");
}

const VALID_HASH = "0123456789abcdef"; // 16 hex chars

describe("validateCiphertextUploadFields", () => {
  it("accepts a well-formed body", () => {
    const result = validateCiphertextUploadFields({ packed_hash: VALID_HASH, raw: file(), packed: file(), thumb: file() });
    expect("error" in result).toBe(false);
  });

  it("rejects a packed_hash that isn't a string", () => {
    const result = validateCiphertextUploadFields({ packed_hash: 12345, raw: file(), packed: file(), thumb: file() });
    expect(result).toEqual({ error: expect.stringContaining("packed_hash") });
  });

  it("rejects a packed_hash of the wrong length", () => {
    const result = validateCiphertextUploadFields({ packed_hash: "tooshort", raw: file(), packed: file(), thumb: file() });
    expect(result).toEqual({ error: expect.stringContaining("packed_hash") });
  });

  it("rejects a missing raw/packed/thumb field", () => {
    expect(validateCiphertextUploadFields({ packed_hash: VALID_HASH, packed: file(), thumb: file() })).toEqual({
      error: expect.stringContaining("required"),
    });
    expect(validateCiphertextUploadFields({ packed_hash: VALID_HASH, raw: file(), thumb: file() })).toEqual({
      error: expect.stringContaining("required"),
    });
    expect(validateCiphertextUploadFields({ packed_hash: VALID_HASH, raw: file(), packed: file() })).toEqual({
      error: expect.stringContaining("required"),
    });
  });

  it("rejects a non-File value for raw/packed/thumb (e.g. a plain form string)", () => {
    const result = validateCiphertextUploadFields({ packed_hash: VALID_HASH, raw: "not-a-file", packed: file(), thumb: file() });
    expect(result).toEqual({ error: expect.stringContaining("required") });
  });
});

describe("readCiphertextUploadBytes", () => {
  it("reads all three files into bytes", async () => {
    const files = { raw: file([1]), packed: file([2, 2]), thumb: file([3, 3, 3]), packedHash: VALID_HASH };
    const result = await readCiphertextUploadBytes(files);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.rawBytes).toEqual(new Uint8Array([1]));
      expect(result.packedBytes).toEqual(new Uint8Array([2, 2]));
      expect(result.thumbBytes).toEqual(new Uint8Array([3, 3, 3]));
    }
  });

  it("rejects when any of the three files is empty", async () => {
    const files = { raw: file([]), packed: file([1]), thumb: file([1]), packedHash: VALID_HASH };
    expect(await readCiphertextUploadBytes(files)).toEqual({ error: expect.stringContaining("Empty") });
  });
});
