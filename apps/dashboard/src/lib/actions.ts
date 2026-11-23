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
type Sender = { cfg: Cfg; wallet: string | null; chainId: number | null; window: WindowView | undefined; maxFeePerGas: bigint | undefined };

const lc = (s: string) => s.toLowerCase();
const txs = (n: bigint) => `${n} tx${n === 1n ? "" : "s"}`;

/** Why the owner's wallet can't send `n` txs to `target` costing `cost` uqor of window budget right now. */
function senderBlockers(s: Sender, notOwner: string, target: { address: string; name: string }, n: bigint, cost: bigint): string[] {
  const out: string[] = [];
  if (!s.wallet) out.push("connect the owner's wallet");
  else {
    if (lc(s.wallet) !== lc(s.cfg.owner)) out.push(notOwner);
    if (s.chainId !== NETWORK.evmChainId) out.push(`switch the wallet to diana (${NETWORK.evmChainId})`);
  }
  const w = s.window;
  if (!w) out.push("reading the owner's EVM window");
  else if (!w.live) out.push("the owner's EVM window is closed");
  else {
    // An empty allowedTargets list means any recipient (chain v3.2.3).
    if (w.allowedTargets.length && !w.allowedTargets.some((t) => lc(t) === lc(target.address))) out.push(`the owner's EVM window does not allow the ${target.name}`);
    if (w.remainingTxs < n) out.push(`the owner's EVM window has ${txs(w.remainingTxs)} left, ${n} needed`);
    if (s.maxFeePerGas !== undefined && w.remainingValue < cost) {
      out.push(`the owner's EVM window has ${fmtUqor(w.remainingValue)} QOR of budget left, ${fmtUqor(cost)} QOR needed`);
    }
  }
  if (s.maxFeePerGas === undefined) out.push("reading the network fee");
  return out;
}

export type RescueRow = { sym: string; token: string; owner: bigint; allowance: bigint };
export type RescuePlan = { tokens: { sym: string; token: string; amount: bigint }[]; cost: bigint; blockers: string[] };

/**
 * "Rescue now" from the owner's wallet: one `vault.rescue(token)` per token with something to move (never an empty
 * rescue: it still burns a window tx and its fee). `cost` is the window budget (uqor) the txs can consume.
 */
export function planRescueNow(i: Sender & { rows: RescueRow[] }): RescuePlan {
  const tokens = i.rows
    .map((r) => ({ sym: r.sym, token: r.token, amount: r.owner < r.allowance ? r.owner : r.allowance }))
    .filter((t) => t.amount > 0n);
  if (!tokens.length) return { tokens, cost: 0n, blockers: ["nothing to move: your tokens are already in the vault (or not approved)"] };
  const n = BigInt(tokens.length);
  const cost = i.maxFeePerGas === undefined ? 0n : n * evmWindowCost({ gas: RESCUE_GAS, maxFeePerGas: i.maxFeePerGas });
  const notOwner = "connect the owner account: the vault accepts rescue only from the owner or the guardian";
  return { tokens, cost, blockers: senderBlockers(i, notOwner, { address: i.cfg.vault, name: "vault" }, n, cost) };
}

export type TopUpPlan = { value: bigint | null; cost: bigint; blockers: string[]; command: string | null };

/**
 * A QOR transfer from the owner's wallet to the guardian. The owner window carries fees only unless it was opened with
 * `--topup`: when the value does not fit (or the window is closed), `command` is the CLI line that opens one that fits.
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
  const blockers = senderBlockers(i, notOwner, { address: i.cfg.guardian, name: "guardian" }, 1n, cost);
  const command = `pnpm cli window open --topup ${formatUnits(value, 18)} --expect ${i.cfg.owner}`;
  const w = i.window;
  const closed = !!w && !w.live;
  const short = !!w?.live && i.maxFeePerGas !== undefined && w.remainingValue < cost;
  if (short) {
    const k = blockers.findIndex((b) => b.includes("QOR of budget left"));
    blockers[k] = `${blockers[k]}: reopen it with top-up headroom (${command})`;
  }
  return { value, cost, blockers, command: closed || short ? command : null };
}

/** Recover's hint for a refusal that names the window or an authorisation. */
export function withWindowHint(msg: string): string {
  return /window|authori[sz]/i.test(msg) ? `${msg} (the submitting account needs a live EVM window)` : msg;
}
