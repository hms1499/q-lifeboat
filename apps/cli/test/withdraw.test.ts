import { describe, expect, it } from "vitest";
import { checkWithdrawalFile, parseWithdrawalFile } from "../src/withdraw";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const good = {
  vault: VAULT,
  to: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  token: "0x1111111111111111111111111111111111111111",
  amount: "1000000000000000000",
  nonce: "3",
  sig: "0xabcd",
};

describe("parseWithdrawalFile", () => {
  it("parses a valid file into typed values", () => {
    const w = parseWithdrawalFile(JSON.stringify(good));
    expect(w.amount).toBe(10n ** 18n);
    expect(w.nonce).toBe(3n);
    expect(w.sig).toBe("0xabcd");
  });
  it("rejects invalid JSON", () => {
    expect(() => parseWithdrawalFile("{")).toThrow(/JSON/);
  });
  it.each(["vault", "to", "token", "amount", "nonce", "sig"])("rejects a missing %s", (k) => {
    const bad: Record<string, unknown> = { ...good };
    delete bad[k];
    expect(() => parseWithdrawalFile(JSON.stringify(bad))).toThrow(new RegExp(k));
  });
  it("rejects a malformed address and a non-decimal amount", () => {
    expect(() => parseWithdrawalFile(JSON.stringify({ ...good, to: "0x12" }))).toThrow(/to/);
    expect(() => parseWithdrawalFile(JSON.stringify({ ...good, amount: "1.5" }))).toThrow(/amount/);
  });
});

describe("checkWithdrawalFile", () => {
  const w = parseWithdrawalFile(JSON.stringify(good));
  it("accepts a matching vault and nonce", () => {
    expect(() => checkWithdrawalFile(w, VAULT.toLowerCase() as `0x${string}`, 3n)).not.toThrow();
  });
  it("refuses a different vault", () => {
    expect(() => checkWithdrawalFile(w, "0x2222222222222222222222222222222222222222", 3n)).toThrow(/vault/i);
  });
  it("refuses a stale nonce with a clear message", () => {
    expect(() => checkWithdrawalFile(w, VAULT, 4n)).toThrow(/stale/i);
  });
});
