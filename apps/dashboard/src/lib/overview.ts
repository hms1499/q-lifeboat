import { RESCUE_SELECTOR } from "@qday/core";
import type { SpendingRules } from "@qorechain/sdk";
import { maxUint256 } from "viem";
import type { Policy } from "./agent";
import type { AgentConfig } from "./config";
import { shortAddr } from "./format";

type Cfg = Pick<AgentConfig, "vault" | "guardian" | "tokens">;
const lc = (s: string) => s.toLowerCase();

/**
 * The agent key's rule on the owner's account, as the chain stores it (Hard rule: exactly
 * `allowedEvmCalls=["<vault>/<rescue selector>"]`, `allowedDenoms=["uqor"]`). The first enabled rule applies.
 */
export function describeAgentRule(rules: SpendingRules, vault: string): { ok: boolean; text: string } {
  const r = rules.rules.find((x) => x.enabled);
  if (!r) return { ok: false, text: "no spending rule" };
  const want = `${lc(vault)}/${RESCUE_SELECTOR}`;
  const callsOk = r.allowedEvmCalls.length === 1 && lc(r.allowedEvmCalls[0]) === want;
  const denomsOk = r.allowedDenoms.length === 1 && r.allowedDenoms[0] === "uqor";
  if (callsOk && denomsOk) return { ok: true, text: "vault.rescue only" };
  return { ok: false, text: `calls ${r.allowedEvmCalls.join(", ") || "any"} · denoms ${r.allowedDenoms.join(", ") || "none"}` };
}

/** The vault can pull a token only up to the owner's allowance; `setup` approves the maximum. */
export function coverage(allowance: bigint): { text: string; tone: "blue" | "orange" } {
  if (allowance === maxUint256) return { text: "Covered", tone: "blue" };
  if (allowance > 0n) return { text: "Partial allowance", tone: "orange" };
  return { text: "Not approved", tone: "orange" };
}

/** Who an outgoing transfer or approval went to, as the owner's policy names it. */
export function labelCounterparty(address: string, cfg: Cfg, policy: Policy | undefined): { label: string; trusted: boolean } {
  const a = lc(address);
  if (a === lc(cfg.vault)) return { label: "Your vault", trusted: true };
  if (a === lc(cfg.guardian)) return { label: "Guardian", trusted: true };
  const t = policy?.trusted.find((e) => lc(e.address) === a);
  if (t) return { label: t.label, trusted: true };
  return { label: shortAddr(address), trusted: false };
}

/** "fUSD, fETH, vault" for a window's allowedTargets. */
export function windowTargetsLabel(targets: readonly string[], cfg: Cfg): string {
  if (!targets.length) return "any address (unscoped)";
  const names: Record<string, string> = {
    [lc(cfg.tokens.fUSD)]: "fUSD",
    [lc(cfg.tokens.fETH)]: "fETH",
    [lc(cfg.tokens.fBTC)]: "fBTC",
    [lc(cfg.vault)]: "vault",
    [lc(cfg.guardian)]: "guardian",
  };
  const known = targets.map((t) => names[lc(t)]).filter(Boolean);
  const other = targets.length - known.length;
  return [known.join(", "), other ? `${other} other` : ""].filter(Boolean).join(" + ");
}
