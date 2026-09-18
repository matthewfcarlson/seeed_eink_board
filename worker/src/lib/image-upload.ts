/**
 * Shared validation for "here's one raw original plus one packed+thumbnail
 * ciphertext variant per board" request bodies — the shape POST
 * /admin/images/upload and POST /admin/buckets/:id/rotate/:rotationId/
 * reencrypt-image/:imageId both accept (a multipart form with a `raw` File,
 * plus per board in BOARD_IDS: `packed__<board>`/`thumb__<board>` Files and
 * a `packed_hash__<board>`/`packed_encoding__<board>` string pair). Factored
 * out so the rotation route doesn't duplicate admin/images.ts's field checks
 * — see root CLAUDE.md's encrypted-buckets plan; neither route ever sees
 * plaintext, so there is nothing here to validate beyond shape (non-empty,
 * right field types). Every board is required: the client (admin.ts's
 * confirmUpload/reencryptOneImage) always generates all of them, and only
 * two boards exist today, so there's no partial-upload case worth supporting.
 */

import { BOARD_IDS, isValidPackedEncoding, type BoardId, type PackedEncoding } from "./media-constants";

export interface CiphertextUploadVariantFields {
  packed: File;
  thumb: File;
  packedHash: string;
  packedEncoding: PackedEncoding;
}

export interface CiphertextUploadFields {
  raw: File;
  variants: Record<BoardId, CiphertextUploadVariantFields>;
}

/** Checks field presence/type only — cheap, synchronous, before touching any bytes. */
export function validateCiphertextUploadFields(body: Record<string, unknown>): CiphertextUploadFields | { error: string } {
  const raw = body.raw;
  if (!(raw instanceof File)) {
    return { error: "raw ciphertext file is required" };
  }

  const variants = {} as Record<BoardId, CiphertextUploadVariantFields>;
  for (const board of BOARD_IDS) {
    const packed = body[`packed__${board}`];
    const thumb = body[`thumb__${board}`];
    const packedHash = body[`packed_hash__${board}`];
    const packedEncoding = body[`packed_encoding__${board}`] ?? "identity";

    if (typeof packedHash !== "string" || packedHash.length !== 16) {
      return { error: `packed_hash__${board} (16-char hex string) is required` };
    }
    if (!(packed instanceof File) || !(thumb instanceof File)) {
      return { error: `packed__${board} and thumb__${board} ciphertext files are required` };
    }
    if (typeof packedEncoding !== "string" || !isValidPackedEncoding(packedEncoding)) {
      return { error: `packed_encoding__${board} must be one of the known PackedEncoding values` };
    }
    variants[board] = { packed, thumb, packedHash, packedEncoding };
  }

  return { raw, variants };
}

export interface CiphertextUploadVariantBytes {
  packedBytes: Uint8Array;
  thumbBytes: Uint8Array;
}

export interface CiphertextUploadBytes {
  rawBytes: Uint8Array;
  variants: Record<BoardId, CiphertextUploadVariantBytes>;
}

/** Reads every file into memory and rejects an empty body — separate from
 *  field validation above since this is async and callers may want to fail
 *  fast on shape errors before spending time reading bytes. */
export async function readCiphertextUploadBytes(fields: CiphertextUploadFields): Promise<CiphertextUploadBytes | { error: string }> {
  const rawBytes = new Uint8Array(await fields.raw.arrayBuffer());
  if (rawBytes.byteLength === 0) return { error: "Empty raw ciphertext body" };

  const variants = {} as Record<BoardId, CiphertextUploadVariantBytes>;
  for (const board of BOARD_IDS) {
    const variant = fields.variants[board];
    const [packedBytes, thumbBytes] = await Promise.all([
      variant.packed.arrayBuffer().then((b) => new Uint8Array(b)),
      variant.thumb.arrayBuffer().then((b) => new Uint8Array(b)),
    ]);
    if (packedBytes.byteLength === 0 || thumbBytes.byteLength === 0) {
      return { error: `Empty ciphertext body for board ${board}` };
    }
    variants[board] = { packedBytes, thumbBytes };
  }

  return { rawBytes, variants };
}
