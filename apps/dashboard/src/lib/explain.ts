import type { Incident } from "@qday/core";
import type { AgentConfig } from "./config";
import { fmtAmount, shortAddr, tokenSymbol } from "./format";
import { big, triggerKind } from "./incidents";

/**
 * Plain words for an incident, built only from the signed fields. It states what the report CLAIMS ("The Guardian
 * reports ..."); the verification badge stays the authority on whether that is true.
 */
export function describeIncident(i: Incident, cfg: AgentConfig | null): { headline: string; detail: string } {
  const t = i.trigger;
  const sym = tokenSymbol(cfg, t.token);
  const to = shortAddr(t.to);
  const is = (a: string | undefined) => !!a && t.to.toLowerCase() === a.toLowerCase();
  const toVault = is(cfg?.vault);
  const toGuardian = is(cfg?.guardian);
  const amt = fmtAmount(big(t.amount));
  const approval = triggerKind(i) === "approval";
  let headline: string;
  if (approval) {
    headline = toVault
      ? `Your vault's ${sym} allowance was ${amt === "unlimited" ? "set to unlimited" : `lowered to ${amt}`}`
      : toGuardian
        ? `Your account approved your Guardian (${to}) to spend ${amt} ${sym}`
        : `Your account approved ${to} to spend ${amt} ${sym}`;
  } else {
    headline = toVault
      ? `${amt} ${sym} left your account to your vault (${to})`
      : toGuardian
        ? `${amt} ${sym} left your account to your Guardian (${to})`
        : `${amt} ${sym} left your account to ${to}, which you don't trust`;
  }

  const rescues = Array.isArray(i.rescues) ? i.rescues : [];
  if (!rescues.length && approval && toVault) {
    return { headline, detail: `No rescue: the Guardian can now rescue at most that much ${sym}. Re-approve the vault to restore full cover.` };
  }
  if (!rescues.length) return { headline, detail: "No rescue: the rules flag this for you, but moving funds would not undo it." };

  const sums = new Map<string, { token: string; sum: bigint }>();
  for (const r of rescues) {
    if (!r.success) continue;
    const key = r.token.toLowerCase();
    const cur = sums.get(key) ?? { token: r.token, sum: 0n };
    cur.sum += big(r.amount);
    sums.set(key, cur);
  }
  const moved = [...sums.values()].filter((m) => m.sum > 0n).map((m) => `${fmtAmount(m.sum)} ${tokenSymbol(cfg, m.token)}`);
  return {
    headline,
    detail: moved.length ? `The Guardian reports it moved ${moved.join(" + ")} into your vault.` : "The Guardian reports it tried a rescue but nothing moved.",
  };
}
