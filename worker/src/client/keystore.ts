/**
 * Browser-local (IndexedDB) fallback storage for a user's sharing keypair,
 * used only when this authenticator never returns a usable WebAuthn PRF
 * result — see admin.ts's login/register handlers and root CLAUDE.md's
 * encrypted-buckets plan. When PRF *is* available, the sharing key is instead
 * recovered fresh on every login from the server's PRF-wrapped copy and never
 * needs to touch local storage at all.
 *
 * This is deliberately per-browser, best-effort storage: it can come back
 * empty (private browsing, cleared site data) or throw (blocked storage), and
 * every caller here degrades to "no local key" rather than surfacing that as
 * an error — losing it just means falling back to generating a fresh keypair,
 * same as a brand-new browser would.
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
