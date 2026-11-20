import type { Hex } from "viem";
import type { OutboundTx } from "@qday/core";

export type { OutboundTx };

export type Policy = {
  /** The GuardianVault: transfers into it are the agent's own rescues and never re-trigger. */
  vault: Hex;
  allowlist: Hex[];
  /** Largest outbound amount (token base units) the owner may send without triggering a rescue. */
  maxOutbound: bigint;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The only place that decides whether funds get moved. Pure and deterministic: no LLM, no I/O.
 */
export function decide(tx: OutboundTx, policy: Policy): { rescue: boolean; reason: string } {
  if (same(tx.to, policy.vault)) return { rescue: false, reason: "transfer into the vault" };
  if (tx.amount > policy.maxOutbound) {
    return { rescue: true, reason: `amount ${tx.amount} exceeds max outbound ${policy.maxOutbound}` };
  }
  if (!policy.allowlist.some((a) => same(a, tx.to))) {
    return { rescue: true, reason: `recipient ${tx.to} is not in the allowlist` };
  }
  return { rescue: false, reason: "allowlisted recipient within limit" };
}
