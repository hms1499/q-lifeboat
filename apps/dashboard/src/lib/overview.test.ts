import { RESCUE_SELECTOR } from "@qday/core";
import { maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { coverage, describeAgentRule, heroRescue, labelCounterparty, windowTargetsLabel } from "./overview";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const cfg = {
  owner: "0x7777777777777777777777777777777777777777",
  vault: VAULT,
  guardian: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  tokens: { fUSD: "0x1111111111111111111111111111111111111111", fETH: "0x2222222222222222222222222222222222222222", fBTC: "0x3333333333333333333333333333333333333333" },
  evmChainId: 9800,
} as const;
const rule = (over = {}) => ({
  id: "guardian",
  enabled: true,
  dailyLimit: 3_000_000n,
  perTxLimit: 1_000_000n,
  allowedDenoms: ["uqor"],
  allowedEvmCalls: [`${VAULT.toLowerCase()}/${RESCUE_SELECTOR}`],
  denomLimits: [],
  ...over,
});

describe("describeAgentRule", () => {
  it("reads 'vault.rescue only' for the exact Hard-rule shape", () => {
    expect(describeAgentRule({ rules: [rule()], authenticatorRules: [] }, VAULT)).toEqual({ ok: true, text: "vault.rescue only" });
  });

  it("uses the first ENABLED rule (chain fact 8)", () => {
    const r = describeAgentRule({ rules: [rule({ enabled: false, allowedEvmCalls: ["0xdead/0x12345678"] }), rule()], authenticatorRules: [] }, VAULT);
    expect(r.ok).toBe(true);
  });

  it("flags an erc20 denom, another call, another vault or no rule", () => {
    expect(describeAgentRule({ rules: [rule({ allowedDenoms: ["uqor", "erc20/0x1111111111111111111111111111111111111111"] })], authenticatorRules: [] }, VAULT).ok).toBe(false);
    expect(describeAgentRule({ rules: [rule({ allowedEvmCalls: [`${VAULT.toLowerCase()}/${RESCUE_SELECTOR}`, "0xabc/0x11111111"] })], authenticatorRules: [] }, VAULT).ok).toBe(false);
    expect(describeAgentRule({ rules: [rule()], authenticatorRules: [] }, "0x2222222222222222222222222222222222222222").ok).toBe(false);
    expect(describeAgentRule({ rules: [], authenticatorRules: [] }, VAULT)).toMatchObject({ ok: false, text: "no spending rule" });
  });
});

describe("coverage", () => {
  it("max allowance → Covered, some → Partial, none → Not approved", () => {
    expect(coverage(maxUint256)).toEqual({ text: "Covered", tone: "blue" });
    expect(coverage(5n)).toEqual({ text: "Partial allowance", tone: "orange" });
    expect(coverage(0n)).toEqual({ text: "Not approved", tone: "orange" });
  });
});

describe("labelCounterparty", () => {
  const policy = { trusted: [{ label: "Cold wallet", address: "0x4444444444444444444444444444444444444444", kind: "wallet" as const }], maxOutbound: "1" };
  it("names the vault, the guardian and trusted entries (any case); anything else is untrusted", () => {
    expect(labelCounterparty(VAULT.toLowerCase(), cfg, policy)).toEqual({ label: "Your vault", trusted: true });
    expect(labelCounterparty(cfg.guardian, cfg, policy)).toEqual({ label: "Guardian", trusted: true });
    expect(labelCounterparty("0x4444444444444444444444444444444444444444".toUpperCase().replace("0X", "0x"), cfg, policy)).toEqual({ label: "Cold wallet", trusted: true });
    expect(labelCounterparty("0x5555555555555555555555555555555555555555", cfg, policy)).toEqual({ label: "0x5555…5555", trusted: false });
    expect(labelCounterparty("0x5555555555555555555555555555555555555555", cfg, undefined).trusted).toBe(false);
  });
});

describe("windowTargetsLabel", () => {
  it("names known targets and counts unknown ones; empty means unscoped", () => {
    expect(windowTargetsLabel([cfg.tokens.fUSD.toUpperCase().replace("0X", "0x"), VAULT, cfg.guardian, "0x9999999999999999999999999999999999999999"], cfg)).toBe(
      "fUSD, vault, guardian + 1 other",
    );
    expect(windowTargetsLabel([], cfg)).toBe("any address (unscoped)");
  });
});

describe("heroRescue (the 'your tokens are safe' banner)", () => {
  const NOW = Date.parse("2026-11-21T12:00:00.000Z");
  const rescue = (id: string, sig: string, min: number, success = true) =>
    ({ id, sig, detectedAt: new Date(NOW - min * 60_000).toISOString(), rescues: [{ success }] }) as never;
  const ok = { ok: true, checks: [] };
  const bad = { ok: false, checks: [] };

  it("test_safeOnlyWhenThatReportIsVerified: safe only when the verdict for that exact report is ok", () => {
    const i = rescue("a", "s1", 5);
    expect(heroRescue([i], () => ok, NOW)).toEqual({ incident: i, state: "safe" });
  });

  it("a failed verdict → 'unverified', never 'safe'", () => {
    const i = rescue("a", "s1", 5);
    expect(heroRescue([i], () => bad, NOW)).toEqual({ incident: i, state: "unverified" });
  });

  it("no verdict yet → 'pending', never 'safe'", () => {
    const i = rescue("a", "s1", 5);
    expect(heroRescue([i], () => undefined, NOW)).toEqual({ incident: i, state: "pending" });
  });

  it("asks the verdict for that incident object (id + sig), not another one", () => {
    const i = rescue("a", "s2", 5);
    const seen: unknown[] = [];
    heroRescue([i], (x) => (seen.push(x), ok), NOW);
    expect(seen).toEqual([i]);
  });

  it("ignores old rescues, alerts and failed-only rescues", () => {
    expect(heroRescue([rescue("a", "s", 31)], () => ok, NOW)).toBeUndefined();
    expect(heroRescue([{ id: "b", sig: "s", detectedAt: new Date(NOW).toISOString(), rescues: [] } as never], () => ok, NOW)).toBeUndefined();
    expect(heroRescue([rescue("c", "s", 1, false)], () => ok, NOW)).toBeUndefined();
  });
});
