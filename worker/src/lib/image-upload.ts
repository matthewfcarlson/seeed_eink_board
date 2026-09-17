/**
 * Shared validation for "here are three already-encrypted ciphertext blobs"
 * request bodies — the shape POST /admin/images/upload and
 * POST /admin/buckets/:id/rotate/:rotationId/reencrypt-image/:imageId both
 * accept (a multipart form with raw/packed/thumb Files plus a packed_hash
 * string). Factored out so the rotation route doesn't duplicate
 * admin/images.ts's field checks — see root CLAUDE.md's encrypted-buckets
 * plan; neither route ever sees plaintext, so there is nothing here to
 * validate beyond shape (non-empty, right field types).
 */

export interface CiphertextUploadFiles {
  raw: File;
  packed: File;
  thumb: File;
  packedHash: string;
}

/** Checks field presence/type only — cheap, synchronous, before touching any bytes. */
export function validateCiphertextUploadFields(body: Record<string, unknown>): CiphertextUploadFiles | { error: string } {
  const packedHash = body.packed_hash;
  const raw = body.raw;
  const packed = body.packed;
  const thumb = body.thumb;

  if (typeof packedHash !== "string" || packedHash.length !== 16) {
    return { error: "packed_hash (16-char hex string) is required" };
  }
  if (!(raw instanceof File) || !(packed instanceof File) || !(thumb instanceof File)) {
    return { error: "raw, packed, and thumb ciphertext files are required" };
  }
  return { raw, packed, thumb, packedHash };
}

export interface CiphertextUploadBytes {
  rawBytes: Uint8Array;
  packedBytes: Uint8Array;
  thumbBytes: Uint8Array;
}

/** Reads the three files into memory and rejects an empty body — separate
 *  from field validation above since this is async and callers may want to
 *  fail fast on shape errors before spending time reading bytes. */
export async function readCiphertextUploadBytes(files: CiphertextUploadFiles): Promise<CiphertextUploadBytes | { error: string }> {
  const [rawBytes, packedBytes, thumbBytes] = await Promise.all([
    files.raw.arrayBuffer().then((b) => new Uint8Array(b)),
    files.packed.arrayBuffer().then((b) => new Uint8Array(b)),
    files.thumb.arrayBuffer().then((b) => new Uint8Array(b)),
  ]);
  if (rawBytes.byteLength === 0 || packedBytes.byteLength === 0 || thumbBytes.byteLength === 0) {
    return { error: "Empty ciphertext body" };
  }
  return { rawBytes, packedBytes, thumbBytes };
}
