import { aesGcmEncryptBlob } from "../../../src/client/crypto";
import type { BoardId } from "../../../src/lib/media-constants";
import type { CiphertextVariant } from "./admin-client";
import { buildDummyBlob, buildEe04TestPackedImage, buildTestPackedImage } from "./test-image";

/**
 * Encrypts both boards' synthetic packed test images under `bucketKey`, for
 * tests that only care about bucket-sharing/rotation mechanics (public-
 * buckets.test.ts, private-bucket-sharing.test.ts) and so don't need to
 * assert on displayed pixel content the way registration-and-image-
 * flow.test.ts does - every upload/reencrypt-image call now requires both
 * boards' variants (migrations/0019_image_board_variants.sql), so this is
 * the shared "just give me something valid for both" fixture.
 */
export async function buildBothBoardVariants(bucketKey: CryptoKey): Promise<Record<BoardId, CiphertextVariant>> {
  const ee02 = buildTestPackedImage();
  const ee04 = buildEe04TestPackedImage();
  const [ee02Packed, ee04Packed, thumb] = await Promise.all([
    aesGcmEncryptBlob(bucketKey, ee02.packed),
    aesGcmEncryptBlob(bucketKey, ee04.packed),
    aesGcmEncryptBlob(bucketKey, buildDummyBlob("thumb")),
  ]);
  return {
    "ee02-13in3": { packedHash: ee02.packedHash, packed: ee02Packed, thumb },
    "ee04-7in3": { packedHash: ee04.packedHash, packed: ee04Packed, thumb },
  };
}
