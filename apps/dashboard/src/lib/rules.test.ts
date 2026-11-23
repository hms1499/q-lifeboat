import { RESCUE_SELECTOR } from "@qday/core";
import { describe, expect, it } from "vitest";
import type { Policy } from "./agent";
import { addTrusted, describeRuleDetail, latestPolicy, MAX_TRUSTED, parseQorAmount, removeTrusted } from "./rules";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const cfg = {
  owner: "0x7777777777777777777777777777777777777777",
  vault: VAULT,
  guardian: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
} as const;
const ALICE = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const policy: Policy = { trusted: [{ label: "Alice", address: ALICE, kind: "wallet" }], maxOutbound: "5000000000000000000" };
const BOB = "0x1234567890123456789012345678901234567890";

describe("addTrusted", () => {
  it("appends a trimmed entry and returns a new policy (the input is untouched)", () => {
    const next = addTrusted(policy, { label: "  Bob's DEX  ", address: ` ${BOB} `, kind: "app" }, cfg);
    expect(next).toEqual({ trusted: [...policy.trusted, { label: "Bob's DEX", address: BOB, kind: "app" }], maxOutbound: policy.maxOutbound });
    expect(policy.trusted).toHaveLength(1);
  });

  it("refuses a malformed address", () => {
    for (const address of ["", "0x123", "1234567890123456789012345678901234567890", `${BOB}00`, "0xZZ34567890123456789012345678901234567890"]) {
      expect(() => addTrusted(policy, { label: "x", address, kind: "wallet" }, cfg), address).toThrow(/0x address/);
    }
  });

  it("refuses an empty or over-long label and an unknown kind", () => {
    expect(() => addTrusted(policy, { label: "   ", address: BOB, kind: "wallet" }, cfg)).toThrow(/label/);
    expect(() => addTrusted(policy, { label: "a".repeat(65), address: BOB, kind: "wallet" }, cfg)).toThrow(/label/);
    expect(addTrusted(policy, { label: "a".repeat(64), address: BOB, kind: "wallet" }, cfg).trusted).toHaveLength(2);
    expect(() => addTrusted(policy, { label: "x", address: BOB, kind: "contract" }, cfg)).toThrow(/wallet.*app/);
  });

  it("refuses a duplicate in any case", () => {
    expect(() => addTrusted(policy, { label: "again", address: ALICE.toLowerCase(), kind: "wallet" }, cfg)).toThrow(/already trusted/);
  });

  it("refuses the owner's own account, and the vault and guardian as redundant", () => {
    expect(() => addTrusted(policy, { label: "me", address: cfg.owner, kind: "wallet" }, cfg)).toThrow(
      "your own account can't be trusted: a leaked key sends from it",
    );
    expect(() => addTrusted(policy, { label: "v", address: VAULT.toLowerCase(), kind: "app" }, cfg)).toThrow(/vault.*always trusted/);
    expect(() => addTrusted(policy, { label: "g", address: cfg.guardian.toUpperCase().replace("0X", "0x"), kind: "wallet" }, cfg)).toThrow(/guardian.*always trusted/);
  });

  it(`refuses more than ${MAX_TRUSTED} entries`, () => {
    const full: Policy = {
      trusted: Array.from({ length: MAX_TRUSTED }, (_, i) => ({ label: `w${i}`, address: `0x${i.toString(16).padStart(40, "a")}`, kind: "wallet" as const })),
      maxOutbound: "0",
    };
    expect(MAX_TRUSTED).toBe(200);
    expect(() => addTrusted(full, { label: "one more", address: BOB, kind: "wallet" }, cfg)).toThrow(/200/);
  });
});

describe("removeTrusted", () => {
  it("removes by address in any case and returns a new policy", () => {
    const next = removeTrusted(policy, ALICE.toLowerCase());
    expect(next).toEqual({ trusted: [], maxOutbound: policy.maxOutbound });
    expect(policy.trusted).toHaveLength(1);
  });

  it("an unknown address is a no-op", () => {
    expect(removeTrusted(policy, BOB)).toEqual(policy);
  });
});

describe("parseQorAmount", () => {
  it("reads a decimal QOR amount as wei (a decimal string)", () => {
    expect(parseQorAmount("1")).toBe("1000000000000000000");
    expect(parseQorAmount("0.5")).toBe("500000000000000000");
    expect(parseQorAmount(" 2.25 ")).toBe("2250000000000000000");
    expect(parseQorAmount("0.000000000000000001")).toBe("1");
    expect(parseQorAmount("007.10")).toBe("7100000000000000000");
  });

  it("accepts 0 (every transfer triggers)", () => {
    expect(parseQorAmount("0")).toBe("0");
    expect(parseQorAmount("0.000")).toBe("0");
  });

  it("refuses negatives, exponents, commas, empty, more than 18 decimals and more than 78 digits", () => {
    for (const bad of ["", "  ", "-1", "1e18", "1,000", "1.", ".5", "0.0000000000000000001", "abc", "1 000", "+1", "9".repeat(61)]) {
      expect(() => parseQorAmount(bad), JSON.stringify(bad)).toThrow();
    }
    expect(parseQorAmount("9".repeat(60))).toBe(`${"9".repeat(60)}${"0".repeat(18)}`);
  });
});

const rule = (over = {}) => ({
  id: "guardian",
  enabled: true,
  dailyLimit: 3_000_000n,
  perTxLimit: 1_000_000n,
  allowedDenoms: ["uqor"],
  allowedEvmCalls: [`${VAULT.toLowerCase()}/${RESCUE_SELECTOR}`],
  denomLimits: [] as { denom: string; perTxLimit: string; dailyLimit: string }[],
  ...over,
});
const row = (rows: ReturnType<typeof describeRuleDetail>, k: string) => rows.find((r) => r.k === k);

describe("describeRuleDetail", () => {
  it("names the vault's rescue call, lists denoms, limits in QOR and flags the Hard-rule match", () => {
    const rows = describeRuleDetail({ rules: [rule()], authenticatorRules: [] }, VAULT);
    expect(row(rows, "Hard rule")).toEqual({ k: "Hard rule", v: "vault.rescue only", ok: true });
    expect(row(rows, "Allowed calls")?.v).toBe("vault.rescue");
    expect(row(rows, "Allowed denoms")?.v).toBe("uqor");
    expect(row(rows, "Per-tx limit")?.v).toBe("1 QOR");
    expect(row(rows, "Daily limit")?.v).toBe("3 QOR");
    expect(row(rows, "Denom limits")?.v).toBe("none");
  });

  it("uses the first enabled rule and shows other calls raw, zero limits as 'no limit'", () => {
    const rows = describeRuleDetail(
      {
        rules: [
          rule({ enabled: false }),
          rule({ allowedEvmCalls: ["0xdead/0x12345678"], allowedDenoms: [], perTxLimit: 0n, dailyLimit: 0n, denomLimits: [{ denom: "uqor", perTxLimit: "500000", dailyLimit: "0" }] }),
        ],
        authenticatorRules: [],
      },
      VAULT,
    );
    expect(row(rows, "Hard rule")?.ok).toBe(false);
    expect(row(rows, "Allowed calls")?.v).toBe("0xdead/0x12345678");
    expect(row(rows, "Allowed denoms")?.v).toBe("any");
    expect(row(rows, "Per-tx limit")?.v).toBe("no limit");
    expect(row(rows, "Daily limit")?.v).toBe("no limit");
    expect(row(rows, "Denom limits")?.v).toBe("uqor: 0.5 QOR per tx, no daily limit");
  });

  it("no enabled rule → a single 'no spending rule on this account' row, not ok", () => {
    expect(describeRuleDetail({ rules: [], authenticatorRules: [] }, VAULT)).toEqual([{ k: "Rule", v: "no spending rule on this account", ok: false }]);
    expect(describeRuleDetail({ rules: [rule({ enabled: false })], authenticatorRules: [] }, VAULT)).toHaveLength(1);
  });
});

describe("latestPolicy (edits build on the newest policy: the PUT answer until a poll started after it lands)", () => {
  const before: Policy = { trusted: [], maxOutbound: "0" };
  const after: Policy = { trusted: policy.trusted, maxOutbound: "1" };

  it("no save yet: the poll", () => {
    expect(latestPolicy({ p: before, gen: 0 }, null)).toBe(before);
    expect(latestPolicy(undefined, null)).toBeUndefined();
  });

  it("a poll started before the save (lower generation) never hides the saved policy", () => {
    expect(latestPolicy({ p: before, gen: 0 }, { p: after, gen: 1 })).toBe(after);
    expect(latestPolicy(undefined, { p: after, gen: 1 })).toBe(after);
  });

  it("a poll started after the save wins (it may carry an outside edit)", () => {
    const outside: Policy = { trusted: [], maxOutbound: "9" };
    expect(latestPolicy({ p: outside, gen: 1 }, { p: after, gen: 1 })).toBe(outside);
    expect(latestPolicy({ p: outside, gen: 2 }, { p: after, gen: 1 })).toBe(outside);
  });
});
