import { evmWindowCost } from "@qorechain/evm/window";
import { maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { APPROVE_GAS } from "./protect";
import { planRevokeApprovals, tokensToRevoke, turnOffSteps, unlinkCommand } from "./turnoff";

const OWNER = "0x7777777777777777777777777777777777777777";
const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const GUARDIAN = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x4444444444444444444444444444444444444444";
const fUSD = "0x1111111111111111111111111111111111111111";
const fETH = "0x2222222222222222222222222222222222222222";
const fBTC = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000;
const FEE = 100_000_000_000n;
const tokens = { fUSD, fETH, fBTC } as const;
const cfg = { owner: OWNER, vault: VAULT, guardian: GUARDIAN } as const;

const win = (over = {}) => ({ live: true, remainingTxs: 5n, remainingValue: 10_000_000_000n, allowedTargets: [fUSD, fETH, fBTC, VAULT, GUARDIAN] as string[], ...over });
const reopen = `pnpm cli window open --expect ${OWNER}`;
const plan = (t: { sym: string; token: string }[], over = {}) =>
  planRevokeApprovals({ cfg, configOk: true, wallet: OWNER, chainId: 9800, window: win(), maxFeePerGas: FEE, tokens: t, ...over });

describe("tokensToRevoke", () => {
  it("one approve(vault, 0) per token with any allowance left, in fUSD, fETH, fBTC order", () => {
    expect(tokensToRevoke({ fUSD: maxUint256, fETH: 0n, fBTC: 1n }, tokens)).toEqual([
      { sym: "fUSD", token: fUSD },
      { sym: "fBTC", token: fBTC },
    ]);
    expect(tokensToRevoke({ fUSD: 0n, fETH: 0n, fBTC: 0n }, tokens)).toEqual([]);
  });
});

describe("planRevokeApprovals", () => {
  it("nothing to do when no allowance is left", () => {
    const p = plan([]);
    expect(p.blockers.join()).toMatch(/nothing to revoke/);
    expect(p.command).toBeNull();
  });
  it("cost = n x approve gas at the fee cap; no blocker in a scoped owner window that lists the tokens", () => {
    const p = plan([{ sym: "fUSD", token: fUSD }, { sym: "fETH", token: fETH }]);
    expect(p.blockers).toEqual([]);
    expect(p.cost).toBe(2n * evmWindowCost({ gas: APPROVE_GAS, maxFeePerGas: FEE }));
    expect(p.command).toBeNull();
  });
  it("needs the owner's wallet: the allowance is the owner's", () => {
    const p = plan([{ sym: "fUSD", token: fUSD }], { wallet: OTHER });
    expect(p.blockers.join()).toMatch(/connect the owner account/);
  });
  it("a closed window, too few txs or a window without a token yields the default (scoped) window command", () => {
    expect(plan([{ sym: "fUSD", token: fUSD }], { window: win({ live: false }) }).command).toBe(reopen);
    const few = plan([{ sym: "fUSD", token: fUSD }, { sym: "fETH", token: fETH }], { window: win({ remainingTxs: 1n }) });
    expect(few.blockers.join()).toMatch(/1 tx left, 2 needed/);
    expect(few.command).toBe(reopen);
    const lacking = plan([{ sym: "fBTC", token: fBTC }], { window: win({ allowedTargets: [fUSD, VAULT] }) });
    expect(lacking.blockers.join()).toMatch(/does not allow fBTC/);
    expect(lacking.command).toBe(reopen);
  });
  it("an unscoped window (no targets) allows every token", () => {
    expect(plan([{ sym: "fBTC", token: fBTC }], { window: win({ allowedTargets: [] }) }).blockers).toEqual([]);
  });
  it("refuses the wrong chain and a budget below the cost (reopen)", () => {
    expect(plan([{ sym: "fUSD", token: fUSD }], { chainId: 1 }).blockers.join()).toMatch(/switch the wallet to diana/);
    const poor = plan([{ sym: "fUSD", token: fUSD }], { window: win({ remainingValue: 1n }) });
    expect(poor.blockers.join()).toMatch(/budget left/);
    expect(poor.command).toBe(reopen);
  });
  it("refuses while the agent config does not match the vault on chain", () => {
    expect(plan([{ sym: "fUSD", token: fUSD }], { configOk: false }).blockers.join()).toMatch(/agent config/);
  });
});

describe("turnOffSteps", () => {
  const live = { scheme: "ed25519", pubkeyHex: "ab", revoked: false, expiryUnix: BigInt(NOW + 3600) };
  const zero = { fUSD: 0n, fETH: 0n, fBTC: 0n };
  it("each step is done only when the chain (or the agent's absence) says so", () => {
    const s = turnOffSteps({ allowances: { ...zero, fETH: maxUint256 }, authenticators: [live], agent: "online", nowUnix: NOW });
    expect(s.map((x) => [x.id, x.done])).toEqual([
      ["approvals", false],
      ["unlink", false],
      ["agent", false],
    ]);
    const off = turnOffSteps({ allowances: zero, authenticators: [{ ...live, revoked: true }], agent: "offline", nowUnix: NOW });
    expect(off.every((x) => x.done)).toBe(true);
  });
  it("the agent step is done only once the agent was asked and did not answer", () => {
    const step = (agent: "online" | "offline" | "unknown") =>
      turnOffSteps({ allowances: zero, authenticators: [], agent, nowUnix: NOW }).find((x) => x.id === "agent")!.done;
    expect(step("unknown")).toBe(false);
    expect(step("online")).toBe(false);
    expect(step("offline")).toBe(true);
  });
  it("an expired key counts as unlinked; unknown reads are not done", () => {
    const s = turnOffSteps({ allowances: undefined, authenticators: [{ ...live, expiryUnix: BigInt(NOW - 1) }], agent: "online", nowUnix: NOW });
    expect(s.find((x) => x.id === "approvals")!.done).toBe(false);
    expect(s.find((x) => x.id === "unlink")!.done).toBe(true);
    expect(turnOffSteps({ allowances: zero, authenticators: undefined, agent: "online", nowUnix: NOW }).find((x) => x.id === "unlink")!.done).toBe(false);
  });
});

it("unlinkCommand names the owner so the CLI refuses another account", () => {
  expect(unlinkCommand(OWNER)).toBe(`pnpm cli unlink --expect ${OWNER}`);
});
