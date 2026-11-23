import { RESCUE_SELECTOR } from "@qday/core";
import type { SpendingRules } from "@qorechain/sdk";
import type { Policy } from "./agent";
import type { AgentConfig } from "./config";
import { fmtUqor } from "./format";
import { describeAgentRule } from "./overview";

/** The agent's own limits (`parsePolicy` in apps/agent/src/policy.ts): the server stays the authority. */
export const MAX_TRUSTED = 200;
const MAX_LABEL = 64;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lc = (s: string) => s.toLowerCase();

type Cfg = Pick<AgentConfig, "owner" | "vault" | "guardian">;

/**
 * The policy with one more trusted wallet or app, or a user-facing refusal. Mirrors `parsePolicy` for early, clear
 * errors, and refuses the owner's own account (a leaked key sends FROM it) and the always-trusted vault and guardian.
 */
export function addTrusted(policy: Policy, entry: { label: string; address: string; kind: string }, cfg: Cfg): Policy {
  const label = entry.label.trim();
  const address = entry.address.trim();
  if (!ADDRESS_RE.test(address)) throw new Error("the address must be a 0x address (0x + 40 hex characters)");
  if (label.length < 1 || label.length > MAX_LABEL) throw new Error(`the label must be 1 to ${MAX_LABEL} characters`);
  if (entry.kind !== "wallet" && entry.kind !== "app") throw new Error('the kind must be "wallet" or "app"');
  const a = lc(address);
  if (a === lc(cfg.owner)) throw new Error("your own account can't be trusted: a leaked key sends from it");
  if (a === lc(cfg.vault)) throw new Error("that is your vault: it is always trusted");
  if (a === lc(cfg.guardian)) throw new Error("that is the guardian: it is always trusted");
  const dup = policy.trusted.find((t) => lc(t.address) === a);
  if (dup) throw new Error(`${address} is already trusted as "${dup.label}"`);
  if (policy.trusted.length >= MAX_TRUSTED) throw new Error(`the trusted list holds at most ${MAX_TRUSTED} entries`);
  return { ...policy, trusted: [...policy.trusted, { label, address, kind: entry.kind }] };
}

/** The policy without that address (any case). An unknown address leaves it as it is. */
export function removeTrusted(policy: Policy, address: string): Policy {
  return { ...policy, trusted: policy.trusted.filter((t) => lc(t.address) !== lc(address)) };
}

/** A policy tagged with the save generation current when its read (poll) or write (PUT) started. */
export type PolicyAt = { p: Policy; gen: number };

/**
 * The policy edits must build on: the agent's answer to the last PUT, until a poll that started after that PUT lands
 * (each write replaces the whole policy, so building on an older read would drop the previous edit).
 */
export function latestPolicy(polled: PolicyAt | undefined, saved: PolicyAt | null): Policy | undefined {
  if (saved && (!polled || polled.gen < saved.gen)) return saved.p;
  return polled?.p;
}

/** A decimal QOR amount (≤ 18 decimals; 0 allowed) as wei, a decimal integer string of at most 78 digits. */
export function parseQorAmount(text: string): string {
  const t = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) throw new Error("enter a QOR amount such as 0.5: digits, an optional dot and at most 18 decimals");
  const [int, frac = ""] = t.split(".");
  const wei = (BigInt(int) * 10n ** 18n + BigInt(frac.padEnd(18, "0"))).toString();
  if (wei.length > 78) throw new Error("that amount is too large");
  return wei;
}

export type RuleRow = { k: string; v: string; ok?: boolean };

const limit = (uqor: bigint) => (uqor === 0n ? "no limit" : `${fmtUqor(uqor)} QOR`);
const baseUnits = (denom: string, raw: string) => {
  const n = /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  return denom === "uqor" ? `${fmtUqor(n)} QOR` : `${raw} base units`;
};

/** The agent's on-chain permission (the first enabled rule on the owner's account), row by row, for the Rules screen. */
export function describeRuleDetail(rules: SpendingRules, vault: string): RuleRow[] {
  const r = rules.rules.find((x) => x.enabled);
  if (!r) return [{ k: "Rule", v: "no spending rule on this account", ok: false }];
  const shape = describeAgentRule(rules, vault);
  const rescue = `${lc(vault)}/${RESCUE_SELECTOR}`;
  const denomLimits = r.denomLimits.map((d) => {
    const perTx = !d.perTxLimit || d.perTxLimit === "0" ? "no per-tx limit" : `${baseUnits(d.denom, d.perTxLimit)} per tx`;
    const daily = !d.dailyLimit || d.dailyLimit === "0" ? "no daily limit" : `${baseUnits(d.denom, d.dailyLimit)} a day`;
    return `${d.denom}: ${perTx}, ${daily}`;
  });
  return [
    { k: "Hard rule", v: shape.text, ok: shape.ok },
    { k: "Allowed calls", v: r.allowedEvmCalls.map((c) => (lc(c) === rescue ? "vault.rescue" : c)).join(", ") || "none (value transfers only)" },
    { k: "Allowed denoms", v: r.allowedDenoms.join(", ") || "any" },
    { k: "Per-tx limit", v: limit(r.perTxLimit) },
    { k: "Daily limit", v: limit(r.dailyLimit) },
    { k: "Denom limits", v: denomLimits.join("; ") || "none" },
  ];
}
