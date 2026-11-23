import { NETWORK } from "@qday/core";
import { evmWindowCost, type EvmWindow } from "@qorechain/evm/window";
import { formatUnits } from "viem";
import type { AgentConfig } from "./config";
import { fmtUqor } from "./format";
import { parseQorAmount } from "./rules";

/**
 * Tight gas limits: diana receipts report at least 50% of the limit as used (chain fact 5). Task 6A on diana via
 * MetaMask: `vault.rescue(token)` used 100000 of 200000, a QOR transfer to the guardian 25000 of 50000.
 */
export const RESCUE_GAS = 200_000n;
export const TOPUP_GAS = 50_000n;
/** `pnpm cli window open --topup` refuses more (a leaked key can spend that headroom). */
const MAX_TOPUP_WEI = 100n * 10n ** 18n;

type Cfg = Pick<AgentConfig, "owner" | "vault" | "guardian">;
export type WindowView = Pick<EvmWindow, "live" | "remainingTxs" | "remainingValue" | "allowedTargets">;
/**
 * `configOk`: the agent's /config matches the vault's immutable owner and guardian on chain (`checkConfigOnChain`). The
 * vault the owner calls and the guardian the QOR goes to come from that config, so nothing is sent until it does.
 */
export type Sender = { cfg: Cfg; configOk: boolean; wallet: string | null; chainId: number | null; window: WindowView | undefined; maxFeePerGas: bigint | undefined };

const lc = (s: string) => s.toLowerCase();
const txs = (n: bigint) => `${n} tx${n === 1n ? "" : "s"}`;

/**
 * Why the owner's wallet can't send `n` txs to `target` costing `cost` uqor of window budget right now. `reopen`: the
 * owner window is closed, lacks the target, or has too few txs or too little budget, all of which reopening it fixes
 * (a new MsgOpenEVMWindow replaces the current one, chain fact 10). `budgetHint` is appended to the budget blocker.
 * `target` null skips the target check (the caller checks targets itself, e.g. a contract creation has none).
 */
export function senderBlockers(
  s: Sender,
  notOwner: string,
  target: { address: string; name: string } | null,
  n: bigint,
  cost: bigint,
  budgetHint = "",
): { blockers: string[]; reopen: boolean } {
  const out: string[] = [];
  let reopen = false;
  if (!s.configOk) out.push("the agent config must match the vault on chain");
  if (!s.wallet) out.push("connect the owner's wallet");
  else {
    if (lc(s.wallet) !== lc(s.cfg.owner)) out.push(notOwner);
    if (s.chainId !== NETWORK.evmChainId) out.push(`switch the wallet to diana (${NETWORK.evmChainId})`);
  }
  const w = s.window;
  if (!w) out.push("reading the owner's EVM window");
  else if (!w.live) {
    out.push("the owner's EVM window is closed");
    reopen = true;
  } else {
    // An empty allowedTargets list means any recipient (chain v3.2.3).
    if (target && w.allowedTargets.length && !w.allowedTargets.some((t) => lc(t) === lc(target.address))) {
      out.push(`the owner's EVM window does not allow the ${target.name}`);
      reopen = true;
    }
    if (w.remainingTxs < n) {
      out.push(`the owner's EVM window has ${txs(w.remainingTxs)} left, ${n} needed`);
      reopen = true;
    }
    if (s.maxFeePerGas !== undefined && w.remainingValue < cost) {
      out.push(`the owner's EVM window has ${fmtUqor(w.remainingValue)} QOR of budget left, ${fmtUqor(cost)} QOR needed${budgetHint}`);
      reopen = true;
    }
  }
  if (s.maxFeePerGas === undefined) out.push("reading the network fee");
  return { blockers: out, reopen };
}

/** What `vault.rescue(token)` moves: the owner's balance, up to the allowance. 0 means skip the token. */
export const rescuable = (balance: bigint, allowance: bigint): bigint => (balance < allowance ? balance : allowance);

export type RescueRow = { sym: string; token: string; owner: bigint; allowance: bigint };
/** `reopen`: show the CLI command that opens the owner window (a window blocker it fixes). */
export type RescuePlan = { tokens: { sym: string; token: string; amount: bigint }[]; cost: bigint; blockers: string[]; reopen: boolean };

/**
 * "Rescue now" from the owner's wallet: one `vault.rescue(token)` per token with something to move (never an empty
 * rescue: it still burns a window tx and its fee). `cost` is the window budget (uqor) the txs can consume.
 */
export function planRescueNow(i: Sender & { rows: RescueRow[] }): RescuePlan {
  const tokens = i.rows.map((r) => ({ sym: r.sym, token: r.token, amount: rescuable(r.owner, r.allowance) })).filter((t) => t.amount > 0n);
  if (!tokens.length) return { tokens, cost: 0n, blockers: ["nothing to move: your tokens are already in the vault (or not approved)"], reopen: false };
  const n = BigInt(tokens.length);
  const cost = i.maxFeePerGas === undefined ? 0n : n * evmWindowCost({ gas: RESCUE_GAS, maxFeePerGas: i.maxFeePerGas });
  const notOwner = "connect the owner account: the vault accepts rescue only from the owner or the guardian";
  return { tokens, cost, ...senderBlockers(i, notOwner, { address: i.cfg.vault, name: "vault" }, n, cost) };
}

export type TopUpPlan = { value: bigint | null; cost: bigint; blockers: string[]; command: string | null };

/**
 * A QOR transfer from the owner's wallet to the guardian. The owner window carries fees only unless it was opened with
 * `--topup`: when reopening it would fix a window blocker (closed, no guardian target, no tx or budget left),
 * `command` is the CLI line that opens one that fits.
 */
export function planTopUp(i: Sender & { amountText: string }): TopUpPlan {
  let value: bigint;
  try {
    value = BigInt(parseQorAmount(i.amountText));
  } catch (e) {
    return { value: null, cost: 0n, blockers: [e instanceof Error ? e.message : String(e)], command: null };
  }
  if (value === 0n) return { value, cost: 0n, blockers: ["enter an amount above 0"], command: null };
  if (value > MAX_TOPUP_WEI) return { value, cost: 0n, blockers: ["at most 100 QOR per top-up (the CLI's --topup cap)"], command: null };
  const cost = i.maxFeePerGas === undefined ? 0n : evmWindowCost({ value, gas: TOPUP_GAS, maxFeePerGas: i.maxFeePerGas });
  const notOwner = "connect the owner account: the CLI opens the owner's window only";
  const command = `pnpm cli window open --topup ${formatUnits(value, 18)} --expect ${i.cfg.owner}`;
  const { blockers, reopen } = senderBlockers(i, notOwner, { address: i.cfg.guardian, name: "guardian" }, 1n, cost, `: reopen it with top-up headroom (${command})`);
  return { value, cost, blockers, command: reopen ? command : null };
}

/** Recover's hint for a refusal that names the window or an authorisation. */
export function withWindowHint(msg: string): string {
  return /window|authori[sz]/i.test(msg) ? `${msg} (the submitting account needs a live EVM window)` : msg;
}
