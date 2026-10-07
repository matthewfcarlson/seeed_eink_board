import { describe, expect, it } from "vitest";
import {
  readCiphertextUploadBytes,
  readCiphertextVariantBytes,
  validateCiphertextUploadFields,
  validateCiphertextVariantFields,
} from "../../src/lib/image-upload";
import { BOARD_IDS, IMAGE_PIPELINE_VERSION } from "../../src/lib/media-constants";

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

describe("validateCiphertextUploadFields content_hash", () => {
  it("accepts a body with a valid 16-hex-char content_hash", () => {
    const result = validateCiphertextUploadFields(validBody({ content_hash: VALID_HASH }));
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.contentHash).toBe(VALID_HASH);
  });

  it("accepts a body without content_hash (optional field, older callers)", () => {
    const result = validateCiphertextUploadFields(validBody());
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.contentHash).toBeUndefined();
  });

  it("rejects a non-string content_hash", () => {
    const result = validateCiphertextUploadFields(validBody({ content_hash: 12345 }));
    expect(result).toEqual({ error: expect.stringContaining("content_hash") });
  });

  it("rejects a content_hash of the wrong length or charset", () => {
    for (const bad of ["short", "0123456789abcdeg", "0123456789ABCDEF"]) {
      const result = validateCiphertextUploadFields(validBody({ content_hash: bad }));
      expect(result).toEqual({ error: expect.stringContaining("content_hash") });
    }
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

describe("cropped__<board> (optional cropped source)", () => {
  it("is null for every board when absent (older callers)", async () => {
    const fields = validateCiphertextUploadFields(validBody());
    if ("error" in fields) throw new Error(fields.error);
    const result = await readCiphertextUploadBytes(fields);
    if ("error" in result) throw new Error(result.error);
    for (const board of BOARD_IDS) expect(result.variants[board].croppedBytes).toBeNull();
  });

  it("reads a board's cropped bytes when present", async () => {
    const fields = validateCiphertextUploadFields(validBody({ [`cropped__${BOARD_IDS[0]}`]: file([4, 4, 4, 4]) }));
    if ("error" in fields) throw new Error(fields.error);
    const result = await readCiphertextUploadBytes(fields);
    if ("error" in result) throw new Error(result.error);
    expect(result.variants[BOARD_IDS[0]!]!.croppedBytes).toEqual(new Uint8Array([4, 4, 4, 4]));
    expect(result.variants[BOARD_IDS[1]!]!.croppedBytes).toBeNull();
  });

  it("rejects a non-File cropped value", () => {
    const result = validateCiphertextUploadFields(validBody({ [`cropped__${BOARD_IDS[0]}`]: "not-a-file" }));
    expect(result).toEqual({ error: expect.stringContaining("cropped__") });
  });

  it("rejects an empty cropped file", async () => {
    const fields = validateCiphertextUploadFields(validBody({ [`cropped__${BOARD_IDS[0]}`]: file([]) }));
    if ("error" in fields) throw new Error(fields.error);
    expect(await readCiphertextUploadBytes(fields)).toEqual({ error: expect.stringContaining("Empty") });
  });
});

describe("pipeline_version", () => {
  it("defaults to 1 when absent (clients from before the field existed)", () => {
    const result = validateCiphertextUploadFields(validBody());
    if ("error" in result) throw new Error(result.error);
    expect(result.pipelineVersion).toBe(1);
  });

  it("accepts every version up to the current one", () => {
    for (let v = 1; v <= IMAGE_PIPELINE_VERSION; v++) {
      const result = validateCiphertextUploadFields(validBody({ pipeline_version: String(v) }));
      if ("error" in result) throw new Error(result.error);
      expect(result.pipelineVersion).toBe(v);
    }
  });

  it("rejects zero, future, non-integer and non-string values", () => {
    for (const bad of ["0", String(IMAGE_PIPELINE_VERSION + 1), "1.5", "-1", "abc", "", 2]) {
      const result = validateCiphertextUploadFields(validBody({ pipeline_version: bad }));
      expect(result).toEqual({ error: expect.stringContaining("pipeline_version") });
    }
  });
});

describe("validateCiphertextVariantFields / readCiphertextVariantBytes (re-render: no raw)", () => {
  it("accepts a body without raw and reads every board's bytes", async () => {
    const { raw, ...withoutRaw } = validBody({ pipeline_version: String(IMAGE_PIPELINE_VERSION) });
    const fields = validateCiphertextVariantFields(withoutRaw);
    if ("error" in fields) throw new Error(fields.error);
    expect(fields.pipelineVersion).toBe(IMAGE_PIPELINE_VERSION);
    const bytes = await readCiphertextVariantBytes(fields);
    if ("error" in bytes) throw new Error(bytes.error);
    for (const board of BOARD_IDS) expect(bytes.variants[board].packedBytes.byteLength).toBeGreaterThan(0);
  });

  it("still rejects a missing variant field", () => {
    const { raw, ...withoutRaw } = validBody();
    delete withoutRaw[`packed__${BOARD_IDS[0]}`];
    expect(validateCiphertextVariantFields(withoutRaw)).toEqual({ error: expect.stringContaining("required") });
  });
});
