/**
 * Browser-local (IndexedDB) cache of a user's recovered sharing keypair — see
 * admin.ts's login/register handlers and root CLAUDE.md's encrypted-buckets
 * plan. Written every time the key is successfully recovered by any means
 * (a fresh PRF-based login, a first registration, or a prior read of this
 * same cache), so a later plain page reload — tryLogin() resuming from the
 * cached API key alone, with no fresh WebAuthn ceremony — has something to
 * restore from without re-prompting for a passkey every single time. Without
 * this, only the no-PRF-authenticator case had anything to restore, and
 * every other reload silently re-locked every bucket.
 *
 * This is deliberately per-browser, best-effort storage: it can come back
 * empty (private browsing, cleared site data) or throw (blocked storage), and
 * every caller here degrades to "no local key" rather than surfacing that as
 * an error.
 */

const DB_NAME = "eink-sharing-key";
const STORE_NAME = "keys";
const RECORD_ID = "self";

export interface LocalSharingKey {
  publicKeyRaw: Uint8Array;
  privateKeyPkcs8: Uint8Array;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function localKeystoreGet(): Promise<LocalSharingKey | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(RECORD_ID);
      req.onsuccess = () => resolve((req.result as LocalSharingKey | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function localKeystoreSet(key: LocalSharingKey): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(key, RECORD_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort — a user on an authenticator without PRF support who also
    // can't persist IndexedDB just regenerates (and re-shares) a keypair next
    // session. Nothing else here depends on this succeeding.
  }
}
