import { RESCUE_SELECTOR } from "@qday/core";
import { evmWindowCost } from "@qorechain/evm";
import { describe, expect, it } from "vitest";
import { buildSetupRule, buildWindowParams, selectLinkMsgs } from "../src/setup";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const TOKENS = {
  fUSD: "0x1111111111111111111111111111111111111111",
  fETH: "0x2222222222222222222222222222222222222222",
  fBTC: "0x3333333333333333333333333333333333333333",
} as const;

describe("buildSetupRule", () => {
  const rule = buildSetupRule(VAULT);

  it("allows exactly one EVM call: vault.rescue", () => {
    expect(rule.allowedEvmCalls).toEqual([`${VAULT.toLowerCase()}/${RESCUE_SELECTOR}`]);
  });

  it("allows only uqor, never an erc20/ denom", () => {
    expect(rule.allowedDenoms).toEqual(["uqor"]);
    expect(rule.allowedDenoms.some((d) => d.startsWith("erc20/"))).toBe(false);
  });

  it("is enabled, named guardian and bounded", () => {
    expect(rule.id).toBe("guardian");
    expect(rule.enabled).toBe(true);
    expect(rule.perTxLimit).toBe("1000000");
    expect(rule.dailyLimit).toBe("3000000");
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
  const msgs = [{ typeUrl: "update-rules" }, { typeUrl: "register" }] as never;
  const pk = new Uint8Array([0xab, 0xcd]);
  const auth = (pubkeyHex: string, revoked: boolean) => ({ pubkeyHex, revoked }) as never;

  it("sends all messages when the agent is not linked", () => {
    expect(selectLinkMsgs(msgs, [], pk)).toHaveLength(2);
    expect(selectLinkMsgs(msgs, [auth("ffff", false)], pk)).toHaveLength(2);
  });

  it("sends only the rules update when the agent is already linked", () => {
    expect(selectLinkMsgs(msgs, [auth("abcd", false)], pk)).toEqual([msgs[0]]);
    expect(selectLinkMsgs(msgs, [auth("0xABCD", false)], pk)).toEqual([msgs[0]]);
  });

  it("re-registers when the linked agent key is revoked", () => {
    expect(selectLinkMsgs(msgs, [auth("abcd", true)], pk)).toHaveLength(2);
  });
});
