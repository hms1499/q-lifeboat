import { CLOSE_EVM_WINDOW_TYPE_URL, checkOpenEvmWindowParams, evmWindowCost, OPEN_EVM_WINDOW_TYPE_URL } from "@qorechain/evm";
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { buildOwnerWindowParams, OWNER_WINDOW_BLOCKS, OWNER_WINDOW_TXS, parseWindowArgs } from "../src/window";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const GUARDIAN = "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94";
const TOKENS = {
  fUSD: "0x1111111111111111111111111111111111111111",
  fETH: "0x2222222222222222222222222222222222222222",
  fBTC: "0x3333333333333333333333333333333333333333",
} as const;
const OWNER = "qor1e7ndejwuym3ltsr6j5av3wxkg9fs50844y3cfd";

describe("parseWindowArgs", () => {
  it("open defaults to 1800 blocks and 5 txs", () => {
    expect(OWNER_WINDOW_BLOCKS).toBe(1800);
    expect(OWNER_WINDOW_TXS).toBe(5);
    expect(parseWindowArgs(["open"])).toEqual({ action: "open", blocks: 1800, txs: 5 });
  });

  it("open takes --blocks and --txs in any order", () => {
    expect(parseWindowArgs(["open", "--blocks", "600", "--txs", "3"])).toEqual({ action: "open", blocks: 600, txs: 3 });
    expect(parseWindowArgs(["open", "--txs", "2"])).toEqual({ action: "open", blocks: 1800, txs: 2 });
  });

  it("close takes no option", () => {
    expect(parseWindowArgs(["close"])).toEqual({ action: "close" });
    expect(() => parseWindowArgs(["close", "--blocks", "5"])).toThrow(/usage/);
  });

  it("refuses unknown actions, unknown flags, missing or non-integer values and out-of-bound values", () => {
    for (const bad of [
      [],
      ["shut"],
      ["open", "--foo", "1"],
      ["open", "--blocks"],
      ["open", "--blocks", "1.5"],
      ["open", "--blocks", "-3"],
      ["open", "--blocks", "0"],
      ["open", "--blocks", "17281"],
      ["open", "--txs", "0"],
      ["open", "--txs", "1001"],
      ["open", "--txs", "2", "--txs", "3"],
      ["open", "extra"],
    ]) {
      expect(() => parseWindowArgs(bad), bad.join(" ")).toThrow();
    }
    expect(parseWindowArgs(["open", "--blocks", "17280", "--txs", "1000"])).toEqual({ action: "open", blocks: 17280, txs: 1000 });
  });
});

describe("buildOwnerWindowParams", () => {
  const p = buildOwnerWindowParams(OWNER, TOKENS, VAULT, GUARDIAN, { blocks: 1800, txs: 5 });

  it("targets exactly fUSD, fETH, fBTC, the vault and the guardian (rescue, approve, top-up in 6E)", () => {
    expect(p.sender).toBe(OWNER);
    expect(p.blocks).toBe(1800);
    expect(p.maxTxs).toBe(5);
    expect(p.allowedTargets).toEqual([TOKENS.fUSD, TOKENS.fETH, TOKENS.fBTC, VAULT, GUARDIAN]);
  });

  it("budgets maxValue as txs x the cost of a 3M-gas tx at 112.5 gwei (fees only, no value headroom)", () => {
    const one = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 112_500_000_000n });
    expect(p.maxValue).toBe((one * 5n).toString());
    const q = buildOwnerWindowParams(OWNER, TOKENS, VAULT, GUARDIAN, { blocks: 600, txs: 2 });
    expect(q.maxValue).toBe((one * 2n).toString());
  });

  it("is accepted by the SDK bounds check and composes MsgOpenEVMWindow", () => {
    expect(() => checkOpenEvmWindowParams(p)).not.toThrow();
    const msg = openEvmWindowMsg(p);
    expect(msg.typeUrl).toBe(OPEN_EVM_WINDOW_TYPE_URL);
  });

  it("refuses duplicate targets (e.g. a guardian equal to the vault)", () => {
    expect(() => buildOwnerWindowParams(OWNER, TOKENS, VAULT, VAULT.toLowerCase(), { blocks: 10, txs: 1 })).toThrow(/duplicate/);
  });

  it("close composes MsgCloseEVMWindow for the owner", () => {
    expect(closeEvmWindowMsg(OWNER).typeUrl).toBe(CLOSE_EVM_WINDOW_TYPE_URL);
  });
});
