import { evmWindowCost } from "@qorechain/evm/window";
import { describe, expect, it } from "vitest";
import { planRescueNow, planTopUp, RESCUE_GAS, TOPUP_GAS, withWindowHint, type WindowView } from "./actions";

const OWNER = "0x7777777777777777777777777777777777777777";
const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const GUARDIAN = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const cfg = { owner: OWNER, vault: VAULT, guardian: GUARDIAN } as const;
const fUSD = "0x1111111111111111111111111111111111111111";
const fETH = "0x2222222222222222222222222222222222222222";
const fBTC = "0x3333333333333333333333333333333333333333";
const FEE = 100_000_000_000n; // 100 gwei
const RESCUE_COST = evmWindowCost({ gas: RESCUE_GAS, maxFeePerGas: FEE }); // 0.02 QOR = 20000 uqor
const E18 = 10n ** 18n;

const win = (over: Partial<WindowView> = {}): WindowView => ({ live: true, remainingTxs: 5n, remainingValue: 10_000_000n, allowedTargets: [fUSD, VAULT, GUARDIAN], ...over });
const rows = [
  { sym: "fUSD", token: fUSD, owner: 100n * E18, allowance: 2n ** 256n - 1n },
  { sym: "fETH", token: fETH, owner: 0n, allowance: 2n ** 256n - 1n },
  { sym: "fBTC", token: fBTC, owner: 5n * E18, allowance: 2n * E18 },
] as const;
const rescue = (over: Partial<Parameters<typeof planRescueNow>[0]> = {}) =>
  planRescueNow({ cfg, configOk: true, wallet: OWNER, chainId: 9800, window: win(), rows: [...rows], maxFeePerGas: FEE, ...over });

describe("planRescueNow", () => {
  it("gas constants: tight limits (receipts report >= 50% of the limit as used)", () => {
    expect(RESCUE_GAS).toBe(200_000n);
    expect(TOPUP_GAS).toBe(50_000n);
    expect(RESCUE_COST).toBe(20_000n);
  });

  it("happy path: one rescue per token with something to move, min(balance, allowance), cost = n x rescue cost", () => {
    const p = rescue();
    expect(p.blockers).toEqual([]);
    expect(p.tokens).toEqual([
      { sym: "fUSD", token: fUSD, amount: 100n * E18 },
      { sym: "fBTC", token: fBTC, amount: 2n * E18 },
    ]);
    expect(p.cost).toBe(2n * RESCUE_COST);
  });

  it("skips zero-balance and zero-allowance rows; nothing left is a blocker", () => {
    const p = rescue({ rows: [{ sym: "fUSD", token: fUSD, owner: 0n, allowance: 5n }, { sym: "fETH", token: fETH, owner: 5n, allowance: 0n }] });
    expect(p.tokens).toEqual([]);
    expect(p.cost).toBe(0n);
    expect(p.blockers).toEqual(["nothing to move: your tokens are already in the vault (or not approved)"]);
  });

  it("the agent's config must match the vault on chain (it names the vault the owner calls)", () => {
    expect(rescue({ configOk: false }).blockers).toEqual(["the agent config must match the vault on chain"]);
  });

  it("no wallet", () => {
    expect(rescue({ wallet: null, chainId: null }).blockers).toEqual(["connect the owner's wallet"]);
  });

  it("a wallet that is not the owner (any case is the same account)", () => {
    expect(rescue({ wallet: GUARDIAN }).blockers).toEqual(["connect the owner account: the vault accepts rescue only from the owner or the guardian"]);
    expect(rescue({ wallet: OWNER.toUpperCase().replace("0X", "0x") }).blockers).toEqual([]);
  });

  it("a wallet on another chain", () => {
    expect(rescue({ chainId: 1 }).blockers).toEqual(["switch the wallet to diana (9800)"]);
    expect(rescue({ chainId: null }).blockers).toEqual(["switch the wallet to diana (9800)"]);
  });

  it("window unread, closed, or not allowing the vault; an empty allowedTargets is unscoped", () => {
    expect(rescue({ window: undefined }).blockers).toEqual(["reading the owner's EVM window"]);
    expect(rescue({ window: win({ live: false }) }).blockers).toEqual(["the owner's EVM window is closed"]);
    expect(rescue({ window: win({ allowedTargets: [fUSD, GUARDIAN] }) }).blockers).toEqual(["the owner's EVM window does not allow the vault"]);
    expect(rescue({ window: win({ allowedTargets: [VAULT.toLowerCase()] }) }).blockers).toEqual([]);
    expect(rescue({ window: win({ allowedTargets: [] }) }).blockers).toEqual([]);
  });

  it("too few txs left in the window", () => {
    expect(rescue({ window: win({ remainingTxs: 1n }) }).blockers).toEqual(["the owner's EVM window has 1 tx left, 2 needed"]);
    expect(rescue({ window: win({ remainingTxs: 2n }) }).blockers).toEqual([]);
  });

  it("too little budget left: cost uses the given maxFeePerGas", () => {
    expect(rescue({ window: win({ remainingValue: 2n * RESCUE_COST - 1n }) }).blockers).toEqual([
      "the owner's EVM window has 0.039999 QOR of budget left, 0.04 QOR needed",
    ]);
    expect(rescue({ window: win({ remainingValue: 2n * RESCUE_COST }) }).blockers).toEqual([]);
    const pricier = rescue({ maxFeePerGas: 2n * FEE });
    expect(pricier.cost).toBe(4n * RESCUE_COST);
  });

  it("fee unknown yet", () => {
    const p = rescue({ maxFeePerGas: undefined });
    expect(p.blockers).toEqual(["reading the network fee"]);
    expect(p.cost).toBe(0n);
  });
});

const topup = (over: Partial<Parameters<typeof planTopUp>[0]> = {}) =>
  planTopUp({ cfg, configOk: true, wallet: OWNER, chainId: 9800, window: win(), amountText: "0.1", maxFeePerGas: FEE, ...over });

describe("planTopUp", () => {
  const cost01 = evmWindowCost({ value: E18 / 10n, gas: TOPUP_GAS, maxFeePerGas: FEE });

  it("happy path: value in wei, cost = value + 50k gas at maxFeePerGas, in uqor", () => {
    const p = topup();
    expect(p.blockers).toEqual([]);
    expect(p.value).toBe(E18 / 10n);
    expect(cost01).toBe(105_000n);
    expect(p.cost).toBe(cost01);
    expect(p.command).toBeNull();
  });

  it("refuses an unreadable, zero or over-cap amount", () => {
    for (const amountText of ["", "-1", "1e3", "abc"]) {
      const p = topup({ amountText });
      expect(p.value, amountText).toBeNull();
      expect(p.blockers[0], amountText).toMatch(/^enter a QOR amount/);
    }
    expect(topup({ amountText: "0" }).blockers).toEqual(["enter an amount above 0"]);
    expect(topup({ amountText: "100.5", window: win({ remainingValue: 10n ** 12n }) }).blockers).toEqual(["at most 100 QOR per top-up (the CLI's --topup cap)"]);
  });

  it("the agent's config must match the vault on chain (it names the guardian the QOR goes to)", () => {
    expect(topup({ configOk: false }).blockers).toEqual(["the agent config must match the vault on chain"]);
  });

  it("the sender must be the owner, on diana", () => {
    expect(topup({ wallet: null, chainId: null }).blockers).toEqual(["connect the owner's wallet"]);
    expect(topup({ wallet: GUARDIAN }).blockers).toEqual(["connect the owner account: the CLI opens the owner's window only"]);
    expect(topup({ chainId: 5 }).blockers).toEqual(["switch the wallet to diana (9800)"]);
  });

  it("window unread / closed / not allowing the guardian / no tx left; empty targets = unscoped", () => {
    expect(topup({ window: undefined }).blockers).toEqual(["reading the owner's EVM window"]);
    const closed = topup({ window: win({ live: false }) });
    expect(closed.blockers).toEqual(["the owner's EVM window is closed"]);
    expect(closed.command).toBe(`pnpm cli window open --topup 0.1 --expect ${OWNER}`);
    expect(topup({ window: win({ allowedTargets: [VAULT] }) }).blockers).toEqual(["the owner's EVM window does not allow the guardian"]);
    expect(topup({ window: win({ allowedTargets: [] }) }).blockers).toEqual([]);
    expect(topup({ window: win({ remainingTxs: 0n }) }).blockers).toEqual(["the owner's EVM window has 0 txs left, 1 needed"]);
  });

  it("a value that does not fit the window budget names the CLI fix", () => {
    const p = topup({ amountText: "0.5", window: win({ remainingValue: 400_000n }) });
    expect(p.blockers).toEqual([
      `the owner's EVM window has 0.4 QOR of budget left, 0.505 QOR needed: reopen it with top-up headroom (pnpm cli window open --topup 0.5 --expect ${OWNER})`,
    ]);
    expect(p.command).toBe(`pnpm cli window open --topup 0.5 --expect ${OWNER}`);
    expect(topup({ amountText: "0.1", window: win({ remainingValue: cost01 }) }).blockers).toEqual([]);
  });

  it("fee unknown yet", () => {
    expect(topup({ maxFeePerGas: undefined }).blockers).toEqual(["reading the network fee"]);
  });
});

describe("withWindowHint", () => {
  it("adds Recover's hint to a window / authorization refusal only", () => {
    expect(withWindowHint("no open EVM authorisation window")).toBe("no open EVM authorisation window (the submitting account needs a live EVM window)");
    expect(withWindowHint("not authorized")).toMatch(/needs a live EVM window\)$/);
    expect(withWindowHint("User rejected the request.")).toBe("User rejected the request.");
  });
});
