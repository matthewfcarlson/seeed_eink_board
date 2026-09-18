import type { WrappedKey } from "../../../src/client/crypto";
import { BOARD_IDS, type BoardId, type PackedEncoding } from "../../../src/lib/media-constants";

/** One board's already-encrypted packed+thumbnail ciphertext for an upload/
 *  reencrypt-image call - see routes/admin/images.ts's doc comment. A bucket
 *  isn't board-scoped (migrations/0019_image_board_variants.sql), so both
 *  routes require every board's variant in one call. */
export interface CiphertextVariant {
  packedHash: string;
  packed: Uint8Array;
  thumb: Uint8Array;
  packedEncoding?: PackedEncoding;
}

/**
 * Thin fetch wrapper over the /admin API this e2e suite exercises - not a
 * general-purpose client, just the handful of calls needed to claim a
 * simulated device, create a bucket, upload an image, and assign the bucket
 * to the device. See worker/openapi.yaml for the full contract.
 */
export class AdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.authHeaders(), ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  /** Binds an unclaimed device's self-reported (mac, secret) pair to this
   *  account - the same call /admin's claim page makes after a QR scan. */
  async claimDevice(mac: string, secret: string): Promise<void> {
    await this.json("/admin/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac, secret }),
    });
  }

  /** Registers a device by mac with a caller-supplied sharing_public_key
   *  directly - a stand-in for a real device's first-boot self-report, used
   *  by tests that don't need the actual firmware/simulator (see
   *  public-buckets.test.ts) and so want a "device" that's really just a
   *  Node-side P-256 keypair this test process holds the private half of.
   *  An optional `secretHex` also lets a test sign real /device_config
   *  requests as this "device" afterwards (lib/device-signature.ts) - a
   *  device registered with no secret resolves to the DEFAULT_DEVICE_KEY
   *  sentinel there, same as a never-claimed device. */
  async registerDeviceWithSharingKey(mac: string, sharingPublicKeyB64: string, secretHex?: string): Promise<void> {
    await this.json("/admin/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac, sharing_public_key: sharingPublicKeyB64, ...(secretHex ? { secret: secretHex } : {}) }),
    });
  }

  async getMe(): Promise<{ id: string; display_name: string | null; is_superuser: boolean }> {
    return this.json("/admin/me", { method: "GET" });
  }

  /** PATCH /admin/me/sharing-key - backfills this account's users.sharing_public_key
   *  (see routes/admin/auth.ts's doc comment: normally a PRF-wrapped copy of the
   *  matching private key, produced after a successful WebAuthn PRF eval). The
   *  Worker validates wire format (lib/webauthn.ts's readSharingKeyWrap) but can
   *  never decrypt wrapped_sharing_key either way - so a test that (like this
   *  one) already holds its principal's real keypair directly in memory can
   *  populate the *public* half through this real endpoint with same-shape
   *  placeholder values for the two fields it never needs to unwrap again. */
  async setSharingPublicKey(credentialId: string, sharingPublicKeyB64: string): Promise<void> {
    await this.json("/admin/me/sharing-key", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential_id: credentialId,
        sharing_public_key: sharingPublicKeyB64,
        // Same shape the real client produces: a 12-byte GCM nonce and a
        // PKCS#8-sized ciphertext blob, both base64.
        wrap_nonce: Buffer.alloc(12).toString("base64"),
        wrapped_sharing_key: Buffer.alloc(121).toString("base64"),
      }),
    });
  }

  async getBuckets(): Promise<
    Array<{
      id: string;
      label: string;
      owner_id: string | null;
      is_owner: boolean;
      is_public: boolean;
      key_version: number;
      key: WrappedKey | null;
      public_key_raw: string | null;
    }>
  > {
    const { buckets } = await this.json<{ buckets: any[] }>("/admin/buckets", { method: "GET" });
    return buckets;
  }

  async patchBucket(
    id: string,
    body: { label?: string; is_public?: boolean; public_key_raw?: string }
  ): Promise<{ id: string; label?: string; is_public?: boolean }> {
    return this.json(`/admin/buckets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async deleteBucket(id: string): Promise<{ deleted: string }> {
    return this.json(`/admin/buckets/${id}`, { method: "DELETE" });
  }

  async getRawImageCiphertext(imageId: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/admin/images/${imageId}/raw`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`GET raw image failed: ${res.status} ${await res.text()}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async listImages(bucketId: string): Promise<Array<{ id: string; filename: string; dither_algorithm: string }>> {
    const { images } = await this.json<{ images: any[] }>(`/admin/images?device_key=${encodeURIComponent(bucketId)}`, {
      method: "GET",
    });
    return images;
  }

  async rotateStart(bucketId: string, key: WrappedKey): Promise<{ rotation_id: string; new_key_version: number; image_ids: string[] }> {
    return this.json(`/admin/buckets/${bucketId}/rotate/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
  }

  async reencryptImage(
    bucketId: string,
    rotationId: string,
    imageId: string,
    opts: { raw: Uint8Array; variants: Record<BoardId, CiphertextVariant> }
  ): Promise<void> {
    const form = buildVariantFormData(opts);
    const res = await fetch(`${this.baseUrl}/admin/buckets/${bucketId}/rotate/${rotationId}/reencrypt-image/${imageId}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw new Error(`reencrypt-image failed: ${res.status} ${await res.text()}`);
  }

  async rotateFinalize(
    bucketId: string,
    rotationId: string,
    body: { user_keys: Record<string, WrappedKey>; device_keys: Record<string, WrappedKey>; public_key_raw?: string }
  ): Promise<void> {
    await this.json(`/admin/buckets/${bucketId}/rotate/${rotationId}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** POST /admin/buckets/:id/invite - mints (or replaces) this bucket's
   *  invite link. `url` carries a `join_bucket=<token>` query param only -
   *  the raw bucket key travels as a `#key=` fragment, appended client-side
   *  (see src/client/admin.ts's createBucketInvite), never sent to or
   *  returned by the server. */
  async inviteBucket(bucketId: string): Promise<{ url: string }> {
    return this.json(`/admin/buckets/${bucketId}/invite`, { method: "POST" });
  }

  /** POST /admin/buckets/join - accepts an invite by token, optionally
   *  supplying the caller's own re-wrap of the raw key read off the invite
   *  link's `#key=` fragment (see src/client/admin.ts's joinBucket). Omitting
   *  `key` only succeeds when the caller turns out to already be the owner. */
  async joinBucket(token: string, key?: WrappedKey): Promise<{ id: string; label: string }> {
    return this.json("/admin/buckets/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...(key ? { key } : {}) }),
    });
  }

  /** GET /admin/buckets/:id/collaborators - owner-only; each collaborator's
   *  sharing_public_key is what the owner's browser needs to re-wrap a fresh
   *  bucket key for them during rotate finalize (see routes/admin/buckets.ts). */
  async getCollaborators(
    bucketId: string
  ): Promise<Array<{ id: string; display_name: string | null; sharing_public_key: string | null }>> {
    const { collaborators } = await this.json<{ collaborators: any[] }>(`/admin/buckets/${bucketId}/collaborators`, {
      method: "GET",
    });
    return collaborators;
  }

  async listDevices(): Promise<Array<{ mac: string; sharing_public_key: string | null }>> {
    const { devices } = await this.json<{ devices: Array<{ mac: string; sharing_public_key: string | null }> }>(
      "/admin/devices",
      { method: "GET" }
    );
    return devices;
  }

  async createBucket(
    label: string,
    wrappedKeyForSelf: WrappedKey,
    opts?: { is_public?: boolean; public_key_raw?: string }
  ): Promise<{ id: string; is_public?: boolean }> {
    return this.json("/admin/buckets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, key: wrappedKeyForSelf, ...opts }),
    });
  }

  async assignBucketToDevice(mac: string, bucketId: string, wrappedKeyForDevice: WrappedKey): Promise<void> {
    await this.json(`/admin/devices/${mac}/buckets`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket_ids: [bucketId], keys: { [bucketId]: wrappedKeyForDevice } }),
    });
  }

  /** Uploads one raw-original ciphertext blob plus, for every board, that
   *  board's packed+thumbnail ciphertext (see worker/src/routes/admin/
   *  images.ts's doc comment). This suite builds synthetic ciphertext
   *  directly (lib/test-image.ts) rather than running the real browser
   *  decode/dither pipeline, since the Worker never inspects plaintext
   *  either way. */
  async uploadImage(
    bucketId: string,
    filename: string,
    opts: { raw: Uint8Array; variants: Record<BoardId, CiphertextVariant> }
  ): Promise<void> {
    const form = buildVariantFormData(opts);
    form.set("dither_algorithm", "floyd_steinberg");

    const res = await fetch(
      `${this.baseUrl}/admin/images/upload?device_key=${encodeURIComponent(bucketId)}&filename=${encodeURIComponent(filename)}`,
      { method: "POST", headers: this.authHeaders(), body: form }
    );
    if (!res.ok) {
      throw new Error(`POST /admin/images/upload failed: ${res.status} ${await res.text()}`);
    }
  }
}

function buildVariantFormData(opts: { raw: Uint8Array; variants: Record<BoardId, CiphertextVariant> }): FormData {
  const form = new FormData();
  form.set("raw", new Blob([new Uint8Array(opts.raw)]), "raw.bin");
  for (const board of BOARD_IDS) {
    const variant = opts.variants[board];
    form.set(`packed_hash__${board}`, variant.packedHash);
    form.set(`packed_encoding__${board}`, variant.packedEncoding ?? "identity");
    form.set(`packed__${board}`, new Blob([new Uint8Array(variant.packed)]), `packed-${board}.bin`);
    form.set(`thumb__${board}`, new Blob([new Uint8Array(variant.thumb)]), `thumb-${board}.bin`);
  }
  return form;
}
