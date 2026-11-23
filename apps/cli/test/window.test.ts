import { CLOSE_EVM_WINDOW_TYPE_URL, checkOpenEvmWindowParams, evmWindowCost, OPEN_EVM_WINDOW_TYPE_URL } from "@qorechain/evm";
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn(async () => "HASH") }));
vi.mock("../src/chain", () => ({ broadcast, publicClient: { readContract: vi.fn(async () => "0x4444444444444444444444444444444444444444") } }));
vi.mock("@qorechain/evm", async (orig) => ({ ...(await orig<object>()), evmWindowStatus: vi.fn(async () => ({ live: false })) }));

import { buildOnboardWindowParams, buildOwnerWindowParams, checkExpectedOwner, ONBOARD_WINDOW_TXS, OWNER_WINDOW_BLOCKS, OWNER_WINDOW_TXS, parseWindowArgs, runWindow } from "../src/window";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const GUARDIAN = "0x4444444444444444444444444444444444444444";
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
    expect(parseWindowArgs(["open"])).toEqual({ action: "open", onboard: false, blocks: 1800, txs: 5, topupUqor: 0n, expect: undefined });
  });

  it("open takes --blocks and --txs in any order", () => {
    expect(parseWindowArgs(["open", "--blocks", "600", "--txs", "3"])).toEqual({ action: "open", onboard: false, blocks: 600, txs: 3, topupUqor: 0n, expect: undefined });
    expect(parseWindowArgs(["open", "--txs", "2"])).toEqual({ action: "open", onboard: false, blocks: 1800, txs: 2, topupUqor: 0n, expect: undefined });
  });

  it("close takes no option", () => {
    expect(parseWindowArgs(["close"])).toEqual({ action: "close", expect: undefined });
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
    expect(parseWindowArgs(["open", "--blocks", "17280", "--txs", "1000"])).toEqual({ action: "open", onboard: false, blocks: 17280, txs: 1000, topupUqor: 0n, expect: undefined });
  });
});

describe("parseWindowArgs --topup <QOR>", () => {
  const topup = (v: string) => (parseWindowArgs(["open", "--topup", v]) as { topupUqor: bigint }).topupUqor;

  it("reads a decimal QOR amount as uqor (1 QOR = 10^6 uqor)", () => {
    expect(topup("0.5")).toBe(500_000n);
    expect(topup("2")).toBe(2_000_000n);
    expect(topup("100")).toBe(100_000_000n);
    expect(topup("0.000001")).toBe(1n);
    expect(topup("1.123456")).toBe(1_123_456n);
    expect(parseWindowArgs(["open", "--txs", "3", "--topup", "1", "--expect", DERIVED])).toEqual({ action: "open", onboard: false, blocks: 1800, txs: 3, topupUqor: 1_000_000n, expect: DERIVED });
  });

  it("rounds UP to the next uqor past 6 decimals (at most 18)", () => {
    expect(topup("0.0000001")).toBe(1n);
    expect(topup("1.1234561")).toBe(1_123_457n);
    expect(topup("0.000000000000000001")).toBe(1n);
    expect(topup("99.999999000000000000")).toBe(99_999_999n);
  });

  it("refuses zero, negative, malformed, over-precise, over-cap, repeated, missing and close --topup, with the usage line", () => {
    for (const bad of [
      ["open", "--topup"],
      ["open", "--topup", "0"],
      ["open", "--topup", "0.000"],
      ["open", "--topup", "-1"],
      ["open", "--topup", "1e3"],
      ["open", "--topup", "1,5"],
      ["open", "--topup", ".5"],
      ["open", "--topup", "1."],
      ["open", "--topup", "abc"],
      ["open", "--topup", ""],
      ["open", "--topup", "0.0000000000000000001"],
      ["open", "--topup", "100.000001"],
      ["open", "--topup", "101"],
      ["open", "--topup", "1", "--topup", "2"],
      ["close", "--topup", "1"],
    ]) {
      expect(() => parseWindowArgs(bad), bad.join(" ")).toThrow(/usage: window open/);
    }
  });
});

describe("buildOwnerWindowParams", () => {
  const p = buildOwnerWindowParams(OWNER, TOKENS, VAULT, GUARDIAN, { blocks: 1800, txs: 5 });

  it("targets exactly fUSD, fETH, fBTC, the vault and the guardian (the guardian target is for 6E's QOR top-ups)", () => {
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

  it("adds exactly the top-up headroom to maxValue; no or zero top-up stays fees only", () => {
    const one = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 112_500_000_000n });
    const t = buildOwnerWindowParams(OWNER, TOKENS, VAULT, GUARDIAN, { blocks: 1800, txs: 5, topupUqor: 500_000n });
    expect(t.maxValue).toBe((one * 5n + 500_000n).toString());
    expect(buildOwnerWindowParams(OWNER, TOKENS, VAULT, GUARDIAN, { blocks: 1800, txs: 5, topupUqor: 0n })).toEqual(p);
    expect(() => checkOpenEvmWindowParams(t)).not.toThrow();
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

// The abandon…about test mnemonic derives 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 (agent config tests).
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DERIVED = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const ENV = { OWNER_MNEMONIC: MNEMONIC, VAULT_ADDRESS: VAULT, FUSD_ADDRESS: TOKENS.fUSD, FETH_ADDRESS: TOKENS.fETH, FBTC_ADDRESS: TOKENS.fBTC };

describe("--expect <owner> (the dashboard's watched owner)", () => {
  afterEach(() => {
    broadcast.mockClear();
    vi.restoreAllMocks();
  });

  it("parses --expect on open and close; refuses a malformed address or a repeat", () => {
    expect(parseWindowArgs(["close", "--expect", DERIVED])).toEqual({ action: "close", expect: DERIVED });
    expect(parseWindowArgs(["open", "--expect", DERIVED, "--txs", "2"])).toEqual({ action: "open", onboard: false, blocks: 1800, txs: 2, topupUqor: 0n, expect: DERIVED });
    expect(() => parseWindowArgs(["close", "--expect", "0x12"])).toThrow(/--expect/);
    expect(() => parseWindowArgs(["close", "--expect"])).toThrow(/--expect/);
    expect(() => parseWindowArgs(["close", "--expect", DERIVED, "--expect", DERIVED])).toThrow();
  });

  it("checkExpectedOwner passes on the same address in any case and refuses another, naming both", () => {
    expect(() => checkExpectedOwner(DERIVED, DERIVED.toLowerCase())).not.toThrow();
    expect(() => checkExpectedOwner(DERIVED, undefined)).not.toThrow();
    expect(() => checkExpectedOwner(DERIVED, "0x7777777777777777777777777777777777777777")).toThrow(
      /0x7777777777777777777777777777777777777777.*0x9858EfFD232B4033E47d90003D41EC34EcaEda94/,
    );
  });

  it("test_windowRefusesWrongOwnerBeforeSigning: close and open with another --expect never broadcast", async () => {
    const other = "0x7777777777777777777777777777777777777777";
    await expect(runWindow(["close", "--expect", other], ENV)).rejects.toThrow(/--expect/);
    await expect(runWindow(["open", "--expect", other], ENV)).rejects.toThrow(/--expect/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("prints the EVM and qor addresses it acts on, and signs when --expect matches", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runWindow(["close", "--expect", DERIVED.toLowerCase()], ENV);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain(DERIVED);
    expect(out).toMatch(/qor1[0-9a-z]+/);
    expect(out).toContain("window close: HASH");
  });

  it("open --topup broadcasts the headroom in maxValue and prints it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runWindow(["open", "--topup", "0.5", "--expect", DERIVED], ENV);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [, msgs] = broadcast.mock.calls[0] as unknown as [unknown, { value: { maxValue: string } }[]];
    const one = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 112_500_000_000n });
    expect(msgs[0].value.maxValue).toBe((one * 5n + 500_000n).toString());
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("top-up headroom 0.5 QOR");
  });

  it("open without --topup prints no headroom", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runWindow(["open", "--expect", DERIVED], ENV);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).not.toContain("top-up");
    expect(out).toContain("window open (1800 blocks, 5 txs, targets fUSD fETH fBTC vault guardian): HASH");
  });
});

describe("window open --onboard (unscoped onboarding window)", () => {
  it("parses with the onboard defaults and combines with --blocks, --txs, --topup, --expect", () => {
    expect(ONBOARD_WINDOW_TXS).toBe(5);
    expect(parseWindowArgs(["open", "--onboard"])).toEqual({ action: "open", onboard: true, blocks: 1800, txs: 5, topupUqor: 0n, expect: undefined });
    expect(parseWindowArgs(["open", "--blocks", "600", "--onboard", "--txs", "3", "--topup", "1", "--expect", DERIVED])).toEqual({
      action: "open", onboard: true, blocks: 600, txs: 3, topupUqor: 1_000_000n, expect: DERIVED,
    });
  });

  it("onboard is false without the flag; a second --onboard and close --onboard throw", () => {
    expect((parseWindowArgs(["open"]) as { onboard: boolean }).onboard).toBe(false);
    expect(() => parseWindowArgs(["open", "--onboard", "--onboard"])).toThrow(/usage/);
    expect(() => parseWindowArgs(["close", "--onboard"])).toThrow(/usage/);
  });

  it("buildOnboardWindowParams has the same per-tx budget, plus top-up headroom, and no allowedTargets key", () => {
    const one = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 112_500_000_000n });
    const p = buildOnboardWindowParams(OWNER, { blocks: 1800, txs: 5, topupUqor: 500_000n });
    expect(p).toEqual({ sender: OWNER, blocks: 1800, maxTxs: 5, maxValue: (one * 5n + 500_000n).toString() });
    expect("allowedTargets" in p).toBe(false);
    expect(buildOnboardWindowParams(OWNER, { blocks: 10, txs: 2, topupUqor: 0n }).maxValue).toBe((one * 2n).toString());
    expect(() => checkOpenEvmWindowParams(p)).not.toThrow();
  });

  it("runWindow open --onboard needs no VAULT_ADDRESS or tokens, warns (env has no vault)", async () => {
    const fakeBroadcast = vi.fn(async () => "OHASH");
    const lines: string[] = [];
    await runWindow(["open", "--onboard", "--topup", "0.5", "--expect", DERIVED], { OWNER_MNEMONIC: MNEMONIC }, {
      broadcast: fakeBroadcast as never,
      windowStatus: async () => ({ live: true, remainingBlocks: 1800n, remainingTxs: 5n }),
      log: (l) => lines.push(l),
    });
    expect(fakeBroadcast).toHaveBeenCalledTimes(1);
    const [, msgs] = fakeBroadcast.mock.calls[0] as unknown as [unknown, { value: Record<string, unknown> }[]];
    // The protobuf message encodes "no targets" as an empty list: unscoped.
    expect((msgs[0].value.allowedTargets as string[] | undefined) ?? []).toEqual([]);
    const out = lines.join("\n");
    expect(out).toContain("window open (onboard, UNSCOPED: any target, 1800 blocks, 5 txs, top-up headroom 0.5 QOR): OHASH");
    expect(out).toContain("unscoped: until it expires or you run `pnpm cli window close`, a leaked ECDSA key can send any tx within this budget");
    expect(out).toContain("owner window live: 1800 blocks, 5 txs left");
  });

  it("onboard refuses another --expect owner before broadcasting", async () => {
    const fakeBroadcast = vi.fn(async () => "X");
    await expect(
      runWindow(["open", "--onboard", "--expect", "0x7777777777777777777777777777777777777777"], { OWNER_MNEMONIC: MNEMONIC }, { broadcast: fakeBroadcast as never, log: () => {} }),
    ).rejects.toThrow(/--expect/);
    expect(fakeBroadcast).not.toHaveBeenCalled();
  });
});
