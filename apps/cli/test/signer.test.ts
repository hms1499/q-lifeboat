import { withdrawalMessage } from "@qday/core";
import { generatePqcKeypair, pqcVerify } from "@qorechain/sdk";
import { hexToBytes, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { assertRegisteredKey, buildWithdrawal, parseAmount, resolveToken } from "../src/signer";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const TO = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TOKEN = "0x1111111111111111111111111111111111111111";
const p = { vault: VAULT, to: TO, token: TOKEN, amount: 10n ** 18n, nonce: 7n } as const;

describe("buildWithdrawal", () => {
  const kp = generatePqcKeypair();
  const w = buildWithdrawal(p, kp.secretKey);

  it("emits the documented JSON shape", () => {
    expect(w).toMatchObject({ vault: VAULT, to: TO, token: TOKEN, amount: "1000000000000000000", nonce: "7" });
    expect(w.sig).toMatch(/^0x[0-9a-f]+$/);
  });

  it("signs exactly withdrawalMessage(...) for chain 9800", () => {
    const msg = withdrawalMessage({ chainId: 9800n, ...p });
    expect(pqcVerify(kp.publicKey, msg, hexToBytes(w.sig))).toBe(true);
  });

  it("does not verify against a different key", () => {
    const msg = withdrawalMessage({ chainId: 9800n, ...p });
    expect(pqcVerify(generatePqcKeypair().publicKey, msg, hexToBytes(w.sig))).toBe(false);
  });

  it("does not verify for a tampered amount, nonce or recipient", () => {
    const sig = hexToBytes(w.sig);
    for (const t of [{ amount: 2n * 10n ** 18n }, { nonce: 8n }, { to: TOKEN as `0x${string}` }]) {
      const msg = withdrawalMessage({ chainId: 9800n, ...p, ...t });
      expect(pqcVerify(kp.publicKey, msg, sig)).toBe(false);
    }
  });
});

describe("resolveToken", () => {
  const tokens = { fUSD: "0x1111111111111111111111111111111111111111", fETH: "0x2222222222222222222222222222222222222222", fBTC: "0x3333333333333333333333333333333333333333" } as const;
  it("maps symbols and QOR", () => {
    expect(resolveToken("fETH", tokens)).toBe(tokens.fETH);
    expect(resolveToken("QOR", tokens)).toBe(zeroAddress);
  });
  it("passes through a 0x address", () => {
    expect(resolveToken(TO, tokens)).toBe(TO);
  });
  it("rejects anything else", () => {
    expect(() => resolveToken("DOGE", tokens)).toThrow(/token/i);
    expect(() => resolveToken("0x12", tokens)).toThrow(/token/i);
  });
});

describe("parseAmount", () => {
  it("parses decimals with 18 decimals", () => {
    expect(parseAmount("1")).toBe(10n ** 18n);
    expect(parseAmount("0.5")).toBe(5n * 10n ** 17n);
  });
  it("rejects zero, negatives and junk", () => {
    expect(() => parseAmount("0")).toThrow(/amount/i);
    expect(() => parseAmount("-1")).toThrow(/amount/i);
    expect(() => parseAmount("abc")).toThrow(/amount/i);
  });
});

describe("assertRegisteredKey", () => {
  const pk = new Uint8Array([1, 2, 3]);
  const ok = { registered: true, possessionProven: true, pubkey: new Uint8Array([1, 2, 3]) };

  it("accepts a registered, proven, matching key (bytes or base64)", () => {
    expect(() => assertRegisteredKey(ok, pk)).not.toThrow();
    expect(() => assertRegisteredKey({ ...ok, pubkey: Buffer.from(pk).toString("base64") }, pk)).not.toThrow();
  });
  it("refuses an unregistered account", () => {
    expect(() => assertRegisteredKey({ registered: false }, pk)).toThrow(/no PQC key registered/);
  });
  it("refuses a key without proof of possession", () => {
    expect(() => assertRegisteredKey({ ...ok, possessionProven: false }, pk)).toThrow(/possession/);
    expect(() => assertRegisteredKey({ ...ok, possessionProven: undefined }, pk)).toThrow(/possession/);
  });
  it("refuses when the status carries no pubkey", () => {
    expect(() => assertRegisteredKey({ registered: true, possessionProven: true }, pk)).toThrow(/no public key/);
  });
  it("refuses a different on-chain key", () => {
    expect(() => assertRegisteredKey({ ...ok, pubkey: new Uint8Array([9, 9, 9]) }, pk)).toThrow(/differs/);
  });
});
