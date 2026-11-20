import { RESCUE_SELECTOR } from "@qday/core";
import { evmWindowCost } from "@qorechain/evm";
import { linkAuthenticatorMsgs, signAuthenticatorLinkEd25519, ruleBoundsEveryDenom, validateEvmDenom, validateSpendingRules } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { buildSetupRule, buildWindowParams, RESCUE_CAP, selectLinkMsgs } from "../src/setup";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const TOKENS = {
  fUSD: "0x1111111111111111111111111111111111111111",
  fETH: "0x2222222222222222222222222222222222222222",
  fBTC: "0x3333333333333333333333333333333333333333",
} as const;

describe("buildSetupRule", () => {
  const MIXED = {
    fUSD: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
    fETH: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
    fBTC: "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc",
  } as const;
  const rule = buildSetupRule(VAULT, MIXED);
  const erc20 = Object.values(MIXED).map((a) => `erc20/${a.toLowerCase()}`);

  it("allows exactly one EVM call: vault.rescue", () => {
    expect(rule.allowedEvmCalls).toEqual([`${VAULT.toLowerCase()}/${RESCUE_SELECTOR}`]);
  });

  it("allows uqor plus exactly the three configured tokens (lowercase, no wildcard)", () => {
    expect(rule.allowedDenoms).toEqual(["uqor", ...erc20]);
    expect(rule.allowedDenoms.filter((d) => d.startsWith("erc20/"))).toHaveLength(3);
    expect(rule.allowedDenoms.some((d) => d.includes("*"))).toBe(false);
  });

  it("caps every token at RESCUE_CAP per tx and per day, never zero or empty", () => {
    expect(RESCUE_CAP).toBe("1000000000000000000000");
    expect(rule.denomLimits.map((l) => l.denom)).toEqual(erc20);
    for (const l of rule.denomLimits) {
      expect(l.perTxLimit).toBe(RESCUE_CAP);
      expect(l.dailyLimit).toBe(RESCUE_CAP);
    }
  });

  it("is enabled, named guardian and bounded in uqor", () => {
    expect(rule.id).toBe("guardian");
    expect(rule.enabled).toBe(true);
    expect(rule.perTxLimit).toBe("1000000");
    expect(rule.dailyLimit).toBe("3000000");
  });

  it("is accepted by the SDK validators", () => {
    expect(() => validateSpendingRules([rule])).not.toThrow();
    for (const d of rule.allowedDenoms) expect(() => validateEvmDenom(d)).not.toThrow();
    expect(ruleBoundsEveryDenom(rule)).toBe(true);
  });

  it("survives the SDK link message builder with the denom limits intact", () => {
    const proof = signAuthenticatorLinkEd25519({ chainId: "qorechain-diana", account: "qor1owner", privateKey: new Uint8Array(32).fill(7) });
    const msgs = linkAuthenticatorMsgs({
      owner: "qor1owner", chainId: "qorechain-diana", ...proof,
      permissions: ["evm"], expiryUnix: 2_000_000_000, label: "t", spendingRule: rule,
    });
    const upd = msgs.find((m) => m.typeUrl.endsWith(".MsgUpdateSpendingRules"))!;
    const r = (upd.value as { rules: { allowedDenoms: string[]; denomLimits: { denom: string; perTxLimit: string; dailyLimit: string }[] }[] }).rules[0];
    expect(r.allowedDenoms).toEqual(rule.allowedDenoms);
    expect(r.denomLimits.map((l) => l.denom)).toEqual(erc20);
    for (const l of r.denomLimits) {
      expect(l.perTxLimit).toBe(RESCUE_CAP);
      expect(l.dailyLimit).toBe(RESCUE_CAP);
    }
  });
});

describe("buildWindowParams", () => {
  const p = buildWindowParams("qor1owner", TOKENS, VAULT);

  it("opens 600 blocks / 10 txs scoped to the three tokens and the vault", () => {
    expect(p.sender).toBe("qor1owner");
    expect(p.blocks).toBe(600);
    expect(p.maxTxs).toBe(10);
    expect(p.allowedTargets).toEqual([TOKENS.fUSD, TOKENS.fETH, TOKENS.fBTC, VAULT]);
  });

  it("budgets maxValue as 10 x the cost of a 3M-gas tx at 112.5 gwei", () => {
    const one = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 112_500_000_000n });
    expect(p.maxValue).toBe((one * 10n).toString());
  });
});

describe("selectLinkMsgs", () => {
  const RULES = "/qorechain.abstractaccount.v1.MsgUpdateSpendingRules";
  const REG = "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator";
  const msgs = [{ typeUrl: REG }, { typeUrl: RULES }];
  const pk = new Uint8Array([0xab, 0xcd]);
  const NOW = 1_000_000;
  const auth = (pubkeyHex: string, revoked: boolean, expiryUnix = BigInt(NOW + 86_400)) => ({ pubkeyHex, revoked, expiryUnix });

  it("sends all messages when the agent is not linked", () => {
    expect(selectLinkMsgs(msgs, [], pk, NOW)).toHaveLength(2);
    expect(selectLinkMsgs(msgs, [auth("ffff", false)], pk, NOW)).toHaveLength(2);
  });

  it("sends only the rules update (picked by typeUrl, not index) when already linked", () => {
    expect(selectLinkMsgs(msgs, [auth("abcd", false)], pk, NOW)).toEqual([msgs[1]]);
    expect(selectLinkMsgs(msgs, [auth("0xABCD", false)], pk, NOW)).toEqual([msgs[1]]);
  });

  it("re-registers when the linked agent key is revoked", () => {
    expect(selectLinkMsgs(msgs, [auth("abcd", true)], pk, NOW)).toHaveLength(2);
  });

  it("treats an expired key, or one expiring within 60 s, as not linked", () => {
    expect(selectLinkMsgs(msgs, [auth("abcd", false, BigInt(NOW - 1))], pk, NOW)).toHaveLength(2);
    expect(selectLinkMsgs(msgs, [auth("abcd", false, BigInt(NOW + 60))], pk, NOW)).toHaveLength(2);
    expect(selectLinkMsgs(msgs, [auth("abcd", false, BigInt(NOW + 61))], pk, NOW)).toHaveLength(1);
  });

  it("throws if the rules message is missing", () => {
    expect(() => selectLinkMsgs([{ typeUrl: REG }], [auth("abcd", false)], pk, NOW)).toThrow(/MsgUpdateSpendingRules/);
  });
});
