import { RESCUE_SELECTOR } from "@qday/core";
import { evmWindowCost } from "@qorechain/evm";
import { linkAuthenticatorMsgs, signAuthenticatorLinkEd25519, ruleBoundsEveryDenom, validateSpendingRules } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { buildSetupRule, buildWindowParams, selectLinkMsgs } from "../src/setup";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const TOKENS = {
  fUSD: "0x1111111111111111111111111111111111111111",
  fETH: "0x2222222222222222222222222222222222222222",
  fBTC: "0x3333333333333333333333333333333333333333",
} as const;

describe("buildSetupRule", () => {
  const rule = buildSetupRule("0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa");
  const VAULT_LC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("allows exactly one EVM call: vault.rescue (lowercase)", () => {
    expect(rule.allowedEvmCalls).toEqual([`${VAULT_LC}/${RESCUE_SELECTOR}`]);
  });

  it("allows only uqor, never an erc20/ denom, and sets no denom limits", () => {
    expect(rule.allowedDenoms).toEqual(["uqor"]);
    expect(rule.allowedDenoms.some((d) => d.startsWith("erc20/"))).toBe(false);
    expect("denomLimits" in rule).toBe(false);
  });

  it("is enabled, named guardian and bounded in uqor", () => {
    expect(rule.id).toBe("guardian");
    expect(rule.enabled).toBe(true);
    expect(rule.perTxLimit).toBe("1000000");
    expect(rule.dailyLimit).toBe("3000000");
  });

  it("is accepted by the SDK validators", () => {
    expect(() => validateSpendingRules([rule])).not.toThrow();
    expect(ruleBoundsEveryDenom(rule)).toBe(true);
  });

  it("survives the SDK link message builder unchanged", () => {
    const proof = signAuthenticatorLinkEd25519({ chainId: "qorechain-diana", account: "qor1owner", privateKey: new Uint8Array(32).fill(7) });
    const msgs = linkAuthenticatorMsgs({
      owner: "qor1owner", chainId: "qorechain-diana", ...proof,
      permissions: ["evm"], expiryUnix: 2_000_000_000, label: "t", spendingRule: rule,
    });
    const upd = msgs.find((m) => m.typeUrl.endsWith(".MsgUpdateSpendingRules"))!;
    const r = (upd.value as { rules: { allowedDenoms: string[]; allowedEvmCalls: string[]; denomLimits?: unknown[] }[] }).rules[0];
    expect(r.allowedDenoms).toEqual(["uqor"]);
    expect(r.allowedEvmCalls).toEqual([`${VAULT_LC}/${RESCUE_SELECTOR}`]);
    expect(r.denomLimits ?? []).toEqual([]);
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
