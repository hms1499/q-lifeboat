import { fmtAmount } from "./format";
import type { Incident } from "@qday/core";
import { bytesToHex, getAddress, type Hex } from "viem";
import { big } from "./incidents";

/** Step 5 sends 10 fUSD from the owner's account to an address nobody trusts. */
export const ATTACK_AMOUNT = 10n * 10n ** 18n;
/** Gas limit of that ERC-20 transfer (diana bills at least half of it, chain fact 5). */
export const ATTACK_GAS = 100_000n;

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * A fresh random address for the try-an-attack transfer: never in `trusted` (any case) and never the zero address, so
 * the Guardian treats the transfer exactly as it would treat a thief's. Nobody holds its key: the 10 fUSD are gone.
 */
export function attackTarget(trusted: string[] = [], fill: (buf: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): Hex {
  const known = new Set(trusted.map((t) => t.toLowerCase()));
  for (;;) {
    const a = bytesToHex(fill(new Uint8Array(20)));
    if (a !== ZERO && !known.has(a)) return getAddress(a);
  }
}

/** The Guardian's report for this transfer (its trigger tx), once it is in. */
export function incidentFor(list: Incident[], transferHash: Hex): Incident | undefined {
  const h = transferHash.toLowerCase();
  return list.find((i) => i.trigger.hash.toLowerCase() === h);
}

/** The successful rescue of the attacked token (the Guardian also rescues every other approved token in the same incident). */
export function fusdRescue(i: Incident, token: Hex): Incident["rescues"][number] | undefined {
  const t = token.toLowerCase();
  return i.rescues.find((r) => r.success && r.token.toLowerCase() === t);
}

/**
 * What the rescue did for the attacked token: the amount it moved into the vault, how many blocks after the transfer it
 * landed (undefined until its receipt is read), and the share of the pre-attack balance of that token the owner kept.
 */
export function attackOutcome(
  i: Incident,
  p: { token: Hex; transferBlock: bigint; rescueBlock: bigint | undefined; balanceBefore: bigint },
): { rescued: bigint; blocksLater: bigint | undefined; keptPct: number } {
  const t = p.token.toLowerCase();
  // Amounts arrive from the agent as decimal strings (JSON has no bigint).
  const rescued = i.rescues.filter((r) => r.success && r.token.toLowerCase() === t).reduce((s, r) => s + big(r.amount), 0n);
  const blocksLater = p.rescueBlock === undefined ? undefined : p.rescueBlock - p.transferBlock;
  const keptPct = p.balanceBefore > 0n ? Number((rescued * 1000n) / p.balanceBefore) / 10 : 0;
  return { rescued, blocksLater, keptPct };
}

/** Whole seconds since `at`, never negative (the ticking clock can still hold a time from before the send). */
export const elapsedSeconds = (now: number, at: number) => Math.max(0, Math.round((now - at) / 1000));

/**
 * The rescue line of the protection test. The block count is measured on the fUSD rescue, so it is attached to fUSD only:
 * the other tokens can land a block later (the report's "Drain to last rescue" counts to the last one).
 */
export function rescueLine(rescued: bigint, blocksLater: bigint | undefined, others: boolean): string {
  const when = blocksLater === undefined ? "" : ` ${blocksLater.toString()} block${blocksLater === 1n ? "" : "s"} later`;
  return `${fmtAmount(rescued)} fUSD moved into your vault${when}${others ? "; your other tokens followed" : ""}`;
}
