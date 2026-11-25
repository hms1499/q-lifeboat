import { generatePqcRecoveryCode, unifiedAccountFromSeed, type PqcStatus } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { createSession } from "./session";
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
    s.providePqc(code, null);
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
    expect(() => s.providePqc(bad, null)).toThrow();
    expect(s.account()).toBeNull();
  });

  it("accepts the matching registered key and rejects another account's code", async () => {
    const s = mk();
    const { code } = await s.create("pw");
    s.providePqc(code, null);
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
    s.providePqc(code, null);
    s.lock();
    expect(s.account()).toBeNull();
    expect(s.classical()).toBeNull();
  });
});
