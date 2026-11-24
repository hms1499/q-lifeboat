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
  const headline =
    triggerKind(i) === "approval"
      ? `Your account approved ${to} to spend ${fmtAmount(big(t.amount))} ${sym}`
      : `${fmtAmount(big(t.amount))} ${sym} left your account to ${to}, which you don't trust`;

  const rescues = Array.isArray(i.rescues) ? i.rescues : [];
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
