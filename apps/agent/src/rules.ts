import type { Hex } from "viem";
import type { OutboundTx } from "@qday/core";

export type { OutboundTx };

export type Policy = {
  /** The GuardianVault: transfers into it are the agent's own rescues and never re-trigger. */
  vault: Hex;
  /**
   * Trusted wallets AND apps: transfers to them (within `maxOutbound`) and approvals to them (any value, since dApps
   * usually ask for an unlimited allowance) never trigger a rescue.
   */
  allowlist: Hex[];
  /** Largest outbound transfer (token base units) the owner may send without triggering a rescue. Transfers only. */
  maxOutbound: bigint;
};

/**
 * `rescue`: move the owner's funds into the vault now. `alert`: record and publish an incident without moving
 * anything (something is wrong but a rescue cannot help). Never both.
 */
export type Decision = { rescue: boolean; alert: boolean; reason: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The only place that decides whether funds get moved. Pure and deterministic: no LLM, no I/O.
 */
export function decide(tx: OutboundTx, policy: Policy): Decision {
  const trusted = policy.allowlist.some((a) => same(a, tx.to));
  if (tx.kind === "approval") {
    if (same(tx.to, policy.vault)) {
      // Review Focus 7 (threat T5): an attacker holding the owner's ECDSA key revokes the vault's allowance so that
      // rescue() can no longer pull this token. A rescue cannot undo that, so the owner gets an alert instead.
      if (tx.amount === 0n) {
        const reason = `approval of 0 to the vault: the owner key revoked the vault allowance on token ${tx.token}`;
        return { rescue: false, alert: true, reason };
      }
      return { rescue: false, alert: false, reason: "approval to the vault (the owner's own setup)" };
    }
    if (tx.amount === 0n) return { rescue: false, alert: false, reason: `approval of 0 to ${tx.to}: a revoke` };
    if (trusted) return { rescue: false, alert: false, reason: `approval to trusted spender ${tx.to}` };
    const reason = `approval of ${tx.amount} to spender ${tx.to}, which is not in the allowlist of trusted wallets and apps`;
    return { rescue: true, alert: false, reason };
  }
  if (same(tx.to, policy.vault)) return { rescue: false, alert: false, reason: "transfer into the vault" };
  if (tx.amount > policy.maxOutbound) {
    return { rescue: true, alert: false, reason: `amount ${tx.amount} exceeds max outbound ${policy.maxOutbound}` };
  }
  if (!trusted) {
    const reason = `recipient ${tx.to} is not in the allowlist of trusted wallets and apps`;
    return { rescue: true, alert: false, reason };
  }
  return { rescue: false, alert: false, reason: "trusted recipient within limit" };
}
