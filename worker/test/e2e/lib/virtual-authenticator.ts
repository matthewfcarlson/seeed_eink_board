import { createHash, generateKeyPairSync } from "node:crypto";
import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

/**
 * Minimal software WebAuthn authenticator - just enough to satisfy
 * verifyRegistrationResponse() (see worker/src/routes/auth-passkey.ts) for
 * attestation "none", so e2e tests can create a real account through the
 * real ceremony without a browser or physical security key. A passkey
 * ceremony is the *only* way to create an account (root CLAUDE.md's
 * encrypted-buckets plan / auth-passkey.ts's doc comment), so there is no
 * bootstrap API to call instead.
 *
 * Uses @levischuck/tiny-cbor directly - the exact CBOR codec
 * @simplewebauthn/server's own decodeAttestationObject/parseAuthenticatorData
 * are built on (see node_modules/@simplewebauthn/server/esm/helpers/iso/isoCBOR.js) -
 * so the encoded bytes are guaranteed byte-compatible with what the server
 * decodes, rather than hand-rolling a CBOR encoder against the spec and
 * hoping it lines up.
 */

interface RegistrationOptionsResponse {
  attemptId: string;
  options: {
    challenge: string;
    rp: { id: string; name: string };
  };
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint16BE(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, false);
  return buf;
}

/**
 * Runs a full /auth/register ceremony against a real Worker instance and
 * returns the minted admin API key - the same key a browser would get back
 * from a successful passkey registration in /admin.
 */
export async function registerTestAccount(baseUrl: string): Promise<{ apiKey: string; credentialId: string }> {
  const optionsRes = await fetch(`${baseUrl}/auth/register/options`, { method: "POST" });
  if (!optionsRes.ok) {
    throw new Error(`POST /auth/register/options failed: ${optionsRes.status} ${await optionsRes.text()}`);
  }
  const { attemptId, options } = (await optionsRes.json()) as RegistrationOptionsResponse;
  const rpId = options.rp.id;

  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = isoBase64URL.toBuffer(jwk.x);
  const y = isoBase64URL.toBuffer(jwk.y);

  const credentialId = Uint8Array.from(crypto.getRandomValues(new Uint8Array(16)));

  // COSE_Key (RFC 9053) EC2/ES256 map - keys per the IANA COSE registry:
  // 1=kty(2=EC2), 3=alg(-7=ES256), -1=crv(1=P-256), -2=x, -3=y.
  const coseKey = new Map<number, CBORType>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
  const coseKeyBytes = encodeCBOR(coseKey);

  // authenticatorData (WebAuthn L2 §6.1): rpIdHash(32) | flags(1) | signCount(4)
  // | attestedCredentialData{ aaguid(16) | credIdLen(2) | credId | credentialPublicKey }.
  // flags = UP(0x01) | UV(0x04) | AT(0x40) - verifyRegistrationResponse defaults
  // both requireUserPresence and requireUserVerification to true.
  const rpIdHash = sha256(new TextEncoder().encode(rpId));
  const flags = new Uint8Array([0x01 | 0x04 | 0x40]);
  const signCount = new Uint8Array(4); // 0 - this authenticator doesn't track one
  const aaguid = new Uint8Array(16); // all-zero: no metadata-service entry needed for attestation "none"
  const authData = concatBytes([
    rpIdHash,
    flags,
    signCount,
    aaguid,
    uint16BE(credentialId.length),
    credentialId,
    coseKeyBytes,
  ]);

  // attestationObject (WebAuthn L2 §6.5.4), fmt "none": empty attStmt, no signature.
  const attestationObject = encodeCBOR(
    new Map<string, CBORType>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ])
  );

  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: baseUrl, crossOrigin: false })
  );

  const credentialIdB64 = isoBase64URL.fromBuffer(credentialId);
  const body = {
    attemptId,
    response: {
      id: credentialIdB64,
      rawId: credentialIdB64,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(Uint8Array.from(attestationObject)),
        transports: ["internal"],
      },
    },
  };

  const verifyRes = await fetch(`${baseUrl}/auth/register/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!verifyRes.ok) {
    throw new Error(`POST /auth/register/verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }
  const { api_key: apiKey } = (await verifyRes.json()) as { api_key: string };
  return { apiKey, credentialId: credentialIdB64 };
}
