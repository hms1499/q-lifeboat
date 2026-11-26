import { generatePqcRecoveryCode, unifiedAccountFromSeed, type PqcStatus } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { createSession } from "./session";
import { encryptSeed } from "./keystore";
import type { KvStore } from "./keystore";

const mem = (): KvStore => {
  let v: unknown = null;
  return { get: async () => v as never, put: async (x) => void (v = x) };
};
const mk = () => createSession({ store: mem(), iter: 1000 });
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

describe("session", () => {
  it("creates, returns the code once, and has no account until the code is provided", async () => {
    const s = mk();
    const { evm, code } = await s.create("pw");
    expect(code).toMatch(/^QRC1-/);
    expect(s.classical()?.evm).toBe(evm);
    expect(s.account()).toBeNull();
    s.providePqc(code, { registered: false });
    expect(s.account()?.evm).toBe(evm);
  });

  it("unlocks from storage with the password", async () => {
    const store = mem();
    const a = createSession({ store, iter: 1000 });
    const { evm } = await a.create("pw");
    const b = createSession({ store, iter: 1000 });
    await expect(b.unlock("nope")).rejects.toThrow("wrong password");
    await b.unlock("pw");
    expect(b.classical()?.evm).toBe(evm);
  });

  it("a mistyped code throws and derives nothing", async () => {
    const s = mk();
    const { code } = await s.create("pw");
    const bad = code.slice(0, -1) + (code.endsWith("0") ? "1" : "0");
    expect(() => s.providePqc(bad, { registered: false })).toThrow();
    expect(s.account()).toBeNull();
  });

  it("accepts the matching registered key and rejects another account's code", async () => {
    const s = mk();
    const { code } = await s.create("pw");
    s.providePqc(code, { registered: false });
    const pub = s.account()!.pqc.publicKey;
    const reg: PqcStatus = { registered: true, pubkey: b64(pub) };
    s.lock();
    await s.unlock("pw");
    s.providePqc(code, reg);
    expect(s.account()).not.toBeNull();

    s.lock();
    await s.unlock("pw");
    const other = unifiedAccountFromSeed(crypto.getRandomValues(new Uint8Array(32)), { recoveryCode: generatePqcRecoveryCode() });
    const wrong: PqcStatus = { registered: true, pubkey: b64(other.pqc.publicKey) };
    expect(() => s.providePqc(code, wrong)).toThrow("this recovery code does not belong to this account");
    expect(s.account()).toBeNull();
  });

  it("lock clears account and classical", async () => {
    const s = mk();
    const { code } = await s.create("pw");
    s.providePqc(code, { registered: false });
    s.lock();
    expect(s.account()).toBeNull();
    expect(s.classical()).toBeNull();
  });

  it("registered without a readable pubkey throws and derives nothing", async () => {
    const s = mk();
    const { code } = await s.create("pw");
    expect(() => s.providePqc(code, { registered: true })).toThrow("could not read the account's registered post-quantum key");
    expect(s.account()).toBeNull();
  });

  it("create refuses to overwrite a wallet unless replace is set", async () => {
    const store = mem();
    const a = createSession({ store, iter: 1000 });
    const first = await a.create("pw");
    const b = createSession({ store, iter: 1000 });
    await expect(b.create("pw2")).rejects.toThrow("a wallet already exists in this browser");
    await b.unlock("pw");
    expect(b.classical()?.evm).toBe(first.evm);
    const second = await b.create("pw2", { replace: true });
    expect(second.evm).not.toBe(first.evm);
  });

  it("unlock rejects a seed that is not 32 bytes or does not match the stored address", async () => {
    const store = mem();
    const base = await encryptSeed(crypto.getRandomValues(new Uint8Array(32)), "pw", 1000);
    // Re-encrypt a 16-byte payload under the same salt/iv/password (encryptSeed itself refuses short seeds).
    const km = await crypto.subtle.importKey("raw", new TextEncoder().encode("pw"), "PBKDF2", false, ["deriveKey"]);
    const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: bytes(base.salt), iterations: 1000 }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(base.iv) }, key, new Uint8Array(16).fill(1)));
    await store.put({ ...base, ct: btoa(String.fromCharCode(...ct)) });
    await expect(createSession({ store, iter: 1000 }).unlock("pw")).rejects.toThrow("this wallet file is damaged");
    const good = await encryptSeed(crypto.getRandomValues(new Uint8Array(32)), "pw", 1000);
    await store.put({ ...good, evm: "0x" + "11".repeat(20) as `0x${string}` });
    await expect(createSession({ store, iter: 1000 }).unlock("pw")).rejects.toThrow("this wallet file is damaged");
    await store.put({ ...good, evm: good.evm.toLowerCase() as `0x${string}` });
    await expect(createSession({ store, iter: 1000 }).unlock("pw")).resolves.toBeUndefined();
  });

  it("lock zeroes the PQ secret key bytes", async () => {
    const s = mk();
    const { code } = await s.create("pw");
    s.providePqc(code, { registered: false });
    const sk = s.account()!.pqc.secretKey;
    expect(sk.some((b) => b !== 0)).toBe(true);
    s.lock();
    expect(sk.every((b) => b === 0)).toBe(true);
  });

  it("onChange fires on create, unlock, providePqc and lock, and stops after unsubscribe", async () => {
    const store = mem();
    const s = createSession({ store, iter: 1000 });
    let n = 0;
    const off = s.onChange(() => n++);
    const { code } = await s.create("pw");
    expect(n).toBe(1);
    s.providePqc(code, { registered: false });
    expect(n).toBe(2);
    s.lock();
    expect(n).toBe(3);
    expect(s.classical()).toBeNull();
    await s.unlock("pw");
    expect(n).toBe(4);
    off();
    s.lock();
    expect(n).toBe(4);
  });
});
