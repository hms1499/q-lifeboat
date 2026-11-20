import { describe, expect, it } from "vitest";
import { loadTokens, loadVault } from "../src/config";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

describe("loadVault", () => {
  it("returns the address from VAULT_ADDRESS", () => {
    expect(loadVault({ VAULT_ADDRESS: A })).toBe(A);
  });
  it("throws naming the variable when missing", () => {
    expect(() => loadVault({})).toThrow(/VAULT_ADDRESS/);
  });
  it("rejects a malformed address", () => {
    expect(() => loadVault({ VAULT_ADDRESS: "0x1234" })).toThrow(/VAULT_ADDRESS/);
    expect(() => loadVault({ VAULT_ADDRESS: "1".repeat(40) })).toThrow(/VAULT_ADDRESS/);
  });
});

describe("loadTokens", () => {
  it("loads the three faucet tokens", () => {
    expect(loadTokens({ FUSD_ADDRESS: A, FETH_ADDRESS: B, FBTC_ADDRESS: C })).toEqual({
      fUSD: A,
      fETH: B,
      fBTC: C,
    });
  });
  it.each(["FUSD_ADDRESS", "FETH_ADDRESS", "FBTC_ADDRESS"])("names %s when missing", (name) => {
    const env: Record<string, string> = { FUSD_ADDRESS: A, FETH_ADDRESS: B, FBTC_ADDRESS: C };
    delete env[name];
    expect(() => loadTokens(env)).toThrow(new RegExp(name));
  });
  it("rejects a malformed address, naming the variable", () => {
    expect(() => loadTokens({ FUSD_ADDRESS: A, FETH_ADDRESS: "nope", FBTC_ADDRESS: C })).toThrow(
      /FETH_ADDRESS/,
    );
  });
});
