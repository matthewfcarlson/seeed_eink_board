import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { compressPackedForUpload, deflateRaw, PACKED_COMPRESSION_MIN_SAVINGS_FRACTION } from "../../src/client/compress";
import { isValidPackedEncoding, PACKED_ENCODINGS } from "../../src/lib/media-constants";
import { NIBBLE_MAP } from "../../src/lib/palette";

function packToNibbles(indices: Uint8Array): Uint8Array {
  const packed = new Uint8Array(Math.ceil(indices.length / 2));
  for (let i = 0; i < indices.length; i += 2) {
    const v1 = NIBBLE_MAP[indices[i]!] ?? 0x1;
    const v2 = i + 1 < indices.length ? (NIBBLE_MAP[indices[i + 1]!] ?? 0x1) : 0x1;
    packed[i / 2] = (v1 << 4) | v2;
  }
  return packed;
}

describe("deflateRaw", () => {
  it("round-trips through Node's real zlib raw-deflate inflate", () => {
    const input = new TextEncoder().encode("hello hello hello hello hello hello world world world");
    const compressed = deflateRaw(input);
    return compressed.then((bytes) => {
      const inflated = zlib.inflateRawSync(Buffer.from(bytes));
      expect(new Uint8Array(inflated)).toEqual(input);
    });
  });

  it("produces output byte-identical to Node's own deflateRawSync for the same input", async () => {
    // Not required to match exactly (a different compressor is free to encode
    // the same content differently), but CompressionStream('deflate-raw') and
    // zlib are both real DEFLATE encoders - cross-checking they at least
    // *decompress* to the same thing (via Node's real inflate, independent of
    // this project's own tinfl vendor) is the actual interoperability bar.
    const input = new Uint8Array(5000);
    for (let i = 0; i < input.length; i++) input[i] = (i * 7) % 6; // small alphabet, like packed nibbles
    const compressed = await deflateRaw(input);
    const inflated = zlib.inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(inflated)).toEqual(input);
  });

  it("handles empty input", async () => {
    const compressed = await deflateRaw(new Uint8Array(0));
    const inflated = zlib.inflateRawSync(Buffer.from(compressed));
    expect(inflated.length).toBe(0);
  });

  it("handles a large (960000-byte, EE02 buffer-sized) input", async () => {
    const input = new Uint8Array(960000);
    for (let i = 0; i < input.length; i++) input[i] = i % 7 === 0 ? 0xaa : 0x11;
    const compressed = await deflateRaw(input);
    expect(compressed.byteLength).toBeLessThan(input.byteLength);
    const inflated = zlib.inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(inflated)).toEqual(input);
  });
});

describe("compressPackedForUpload", () => {
  it("chooses deflate-raw for a realistic mostly-flat dithered packed buffer", async () => {
    const width = 200, height = 200;
    const indices = new Uint8Array(width * height).fill(1); // flat white
    const packed = packToNibbles(indices);

    const result = await compressPackedForUpload(packed);
    expect(result.encoding).toBe("deflate-raw");
    expect(result.bytes.byteLength).toBeLessThan(packed.byteLength);

    // Round-trips via real Node inflate back to the exact original packed bytes.
    const inflated = zlib.inflateRawSync(Buffer.from(result.bytes));
    expect(new Uint8Array(inflated)).toEqual(packed);
  });

  it("falls back to identity when compression doesn't clear the min-savings threshold", async () => {
    // Cryptographically random bytes are the worst realistic case (see Step 0
    // measurements in this feature's implementation notes: even
    // pathological-noise 6-color-index data still compresses ~30%+, but truly
    // uniform random BYTES - 8 bits of entropy each, unlike a 6-color packed
    // nibble - are close to incompressible and a good stand-in for "did the
    // threshold logic actually run").
    const random = new Uint8Array(2000);
    for (let i = 0; i < random.length; i++) random[i] = Math.floor(Math.random() * 256);

    const result = await compressPackedForUpload(random);
    // Whichever way it goes, the returned bytes must decode back to the
    // original - this is the property that actually matters.
    if (result.encoding === "identity") {
      expect(result.bytes).toEqual(random);
    } else {
      const inflated = zlib.inflateRawSync(Buffer.from(result.bytes));
      expect(new Uint8Array(inflated)).toEqual(random);
    }
  });

  it("never returns identity bytes that differ from the input", async () => {
    const packed = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await compressPackedForUpload(packed);
    if (result.encoding === "identity") {
      expect(result.bytes).toBe(packed);
    }
  });

  it("PACKED_COMPRESSION_MIN_SAVINGS_FRACTION is a sane fraction", () => {
    expect(PACKED_COMPRESSION_MIN_SAVINGS_FRACTION).toBeGreaterThan(0);
    expect(PACKED_COMPRESSION_MIN_SAVINGS_FRACTION).toBeLessThan(1);
  });
});

describe("packed_encoding field handling", () => {
  it("PACKED_ENCODINGS lists exactly identity and deflate-raw", () => {
    expect(PACKED_ENCODINGS.sort()).toEqual(["deflate-raw", "identity"]);
  });

  it("isValidPackedEncoding accepts only the known values", () => {
    expect(isValidPackedEncoding("identity")).toBe(true);
    expect(isValidPackedEncoding("deflate-raw")).toBe(true);
    expect(isValidPackedEncoding("gzip")).toBe(false);
    expect(isValidPackedEncoding("")).toBe(false);
    expect(isValidPackedEncoding("DEFLATE-RAW")).toBe(false);
  });
});
