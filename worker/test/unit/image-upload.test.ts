import { describe, expect, it } from "vitest";
import { readCiphertextUploadBytes, validateCiphertextUploadFields } from "../../src/lib/image-upload";
import { BOARD_IDS } from "../../src/lib/media-constants";

function file(bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], "blob");
}

const VALID_HASH = "0123456789abcdef"; // 16 hex chars

/** A well-formed body: one `raw` plus every board's packed/thumb/hash fields. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { raw: file() };
  for (const board of BOARD_IDS) {
    body[`packed__${board}`] = file();
    body[`thumb__${board}`] = file();
    body[`packed_hash__${board}`] = VALID_HASH;
  }
  return { ...body, ...overrides };
}

describe("validateCiphertextUploadFields", () => {
  it("accepts a well-formed body", () => {
    const result = validateCiphertextUploadFields(validBody());
    expect("error" in result).toBe(false);
  });

  it("rejects a packed_hash that isn't a string", () => {
    const result = validateCiphertextUploadFields(validBody({ [`packed_hash__${BOARD_IDS[0]}`]: 12345 }));
    expect(result).toEqual({ error: expect.stringContaining("packed_hash") });
  });

  it("rejects a packed_hash of the wrong length", () => {
    const result = validateCiphertextUploadFields(validBody({ [`packed_hash__${BOARD_IDS[0]}`]: "tooshort" }));
    expect(result).toEqual({ error: expect.stringContaining("packed_hash") });
  });

  it("rejects a missing raw field", () => {
    const { raw, ...rest } = validBody();
    expect(validateCiphertextUploadFields(rest)).toEqual({ error: expect.stringContaining("raw") });
  });

  it("rejects a missing packed/thumb field for one board", () => {
    const board = BOARD_IDS[0];
    const withoutPacked = validBody();
    delete withoutPacked[`packed__${board}`];
    expect(validateCiphertextUploadFields(withoutPacked)).toEqual({ error: expect.stringContaining("required") });

    const withoutThumb = validBody();
    delete withoutThumb[`thumb__${board}`];
    expect(validateCiphertextUploadFields(withoutThumb)).toEqual({ error: expect.stringContaining("required") });
  });

  it("rejects a non-File value for raw (e.g. a plain form string)", () => {
    const result = validateCiphertextUploadFields(validBody({ raw: "not-a-file" }));
    expect(result).toEqual({ error: expect.stringContaining("required") });
  });

  it("rejects an invalid packed_encoding for one board", () => {
    const result = validateCiphertextUploadFields(validBody({ [`packed_encoding__${BOARD_IDS[0]}`]: "gzip" }));
    expect(result).toEqual({ error: expect.stringContaining("packed_encoding") });
  });
});

describe("readCiphertextUploadBytes", () => {
  it("reads raw plus every board's packed/thumb bytes", async () => {
    const fields = validateCiphertextUploadFields(
      validBody({
        raw: file([1]),
        [`packed__${BOARD_IDS[0]}`]: file([2, 2]),
        [`thumb__${BOARD_IDS[0]}`]: file([3, 3, 3]),
      })
    );
    if ("error" in fields) throw new Error(fields.error);
    const result = await readCiphertextUploadBytes(fields);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.rawBytes).toEqual(new Uint8Array([1]));
      expect(result.variants[BOARD_IDS[0]!]!.packedBytes).toEqual(new Uint8Array([2, 2]));
      expect(result.variants[BOARD_IDS[0]!]!.thumbBytes).toEqual(new Uint8Array([3, 3, 3]));
    }
  });

  it("rejects when raw is empty", async () => {
    const fields = validateCiphertextUploadFields(validBody({ raw: file([]) }));
    if ("error" in fields) throw new Error(fields.error);
    expect(await readCiphertextUploadBytes(fields)).toEqual({ error: expect.stringContaining("Empty") });
  });

  it("rejects when a board's packed/thumb file is empty", async () => {
    const fields = validateCiphertextUploadFields(validBody({ [`packed__${BOARD_IDS[0]}`]: file([]) }));
    if ("error" in fields) throw new Error(fields.error);
    expect(await readCiphertextUploadBytes(fields)).toEqual({ error: expect.stringContaining("Empty") });
  });
});
