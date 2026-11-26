import { bytesToHex, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/** The seed encrypted with the user's password. The recovery code is never part of it. */
export type EncryptedSeed = {
  v: 1;
  kdf: "pbkdf2-sha256";
  iter: number;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
  evm: Hex;
};

export const DEFAULT_ITERATIONS = 600_000;

const enc = new TextEncoder();

const toB64 = (u: Uint8Array): string => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSeed(seed: Uint8Array, password: string, iter = DEFAULT_ITERATIONS): Promise<EncryptedSeed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iter);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seed as Uint8Array<ArrayBuffer>));
  return {
    v: 1,
    kdf: "pbkdf2-sha256",
    iter,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
    evm: privateKeyToAddress(bytesToHex(seed)),
  };
}

/** Throws Error("wrong password") when the password (or the ciphertext) fails AES-GCM authentication. */
export async function decryptSeed(e: EncryptedSeed, password: string): Promise<Uint8Array> {
  try {
    const key = await deriveKey(password, fromB64(e.salt), e.iter);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(e.iv) }, key, fromB64(e.ct)));
  } catch {
    throw new Error("wrong password");
  }
}

/** Minimal one-record store, so tests can swap IndexedDB for memory. */
export interface KvStore {
  get(): Promise<EncryptedSeed | null>;
  put(e: EncryptedSeed): Promise<void>;
}

const DB = "qlifeboat";
const STORE = "wallet";
const KEY = "seed";

/** Production store: one IndexedDB database, one object store, one record. */
export function indexedDbStore(): KvStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const r = f(db.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: async () => ((await run("readonly", (s) => s.get(KEY))) as EncryptedSeed | undefined) ?? null,
    put: async (e) => void (await run("readwrite", (s) => s.put(e, KEY))),
  };
}

export const saveSeed = (e: EncryptedSeed, store: KvStore = indexedDbStore()) => store.put(e);
export const loadSeed = (store: KvStore = indexedDbStore()) => store.get();

export function exportSeedFile(e: EncryptedSeed): Blob {
  return new Blob([JSON.stringify(e, null, 2)], { type: "application/json" });
}

export function importSeedFile(text: string): EncryptedSeed {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error("not a wallet file");
  }
  const str = (x: unknown) => typeof x === "string" && x.length > 0;
  if (
    !o || o.v !== 1 || o.kdf !== "pbkdf2-sha256" || !Number.isSafeInteger(o.iter) || o.iter < 100_000 || o.iter > 10_000_000 ||
    !str(o.salt) || !str(o.iv) || !str(o.ct) || typeof o.evm !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.evm)
  ) {
    throw new Error("not a wallet file");
  }
  return { v: 1, kdf: o.kdf, iter: o.iter, salt: o.salt, iv: o.iv, ct: o.ct, evm: o.evm };
}
