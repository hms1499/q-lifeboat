import { evmWindowCost } from "@qorechain/evm/window";
import type { AuthenticatorView } from "@qorechain/sdk";
import { senderBlockers, type Sender } from "./actions";
import { APPROVE_GAS, hasLiveAuthenticator, TOKEN_SYMBOLS, type ApproveToken } from "./protect";

/**
 * "Turn off protection". The agent rescues through the guardian account (vault.rescue, chain fact 7), so what stops
 * rescues is the vault's allowance: `approve(vault, 0)` per token, from the owner's wallet inside an owner window.
 * Unlinking the Guardian's key (`pnpm cli unlink`, a hybrid tx) removes its on-chain permission; stopping the agent
 * ends the watching and the alerts. Each `approve(vault, 0)` raises an alert while the agent runs (Review Focus 7).
 */

type Allowances = { fUSD: bigint; fETH: bigint; fBTC: bigint };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One `approve(vault, 0)` per token whose allowance to the vault is above 0. */
export function tokensToRevoke(allowances: Allowances, tokens: { fUSD: string; fETH: string; fBTC: string }): ApproveToken[] {
  return TOKEN_SYMBOLS.filter((sym) => allowances[sym] > 0n).map((sym) => ({ sym, token: tokens[sym] }));
}

export type RevokePlan = { cost: bigint; blockers: string[]; command: string | null };

/** The default `pnpm cli window open` is scoped to fUSD, fETH, fBTC, the vault and the guardian: enough here. */
const windowCommand = (owner: string) => `pnpm cli window open --expect ${owner}`;

/**
 * `approve(vault, 0)` for each token: n owner-window txs and `n x APPROVE_GAS` of budget at the fee cap. A window with
 * targets must list every token. A closed or too-small window yields the command that opens a fitting one.
 */
export function planRevokeApprovals(s: Sender & { tokens: ApproveToken[] }): RevokePlan {
  if (!s.tokens.length) return { cost: 0n, blockers: ["nothing to revoke: the vault has no allowance left"], command: null };
  const n = BigInt(s.tokens.length);
  const cost = s.maxFeePerGas === undefined ? 0n : n * evmWindowCost({ gas: APPROVE_GAS, maxFeePerGas: s.maxFeePerGas });
  const notOwner = "connect the owner account: the allowances are the owner's";
  const { blockers, reopen: r } = senderBlockers(s, notOwner, null, n, cost);
  let reopen = r;
  const w = s.window;
  if (w?.live && w.allowedTargets.length) {
    const lacking = s.tokens.filter((t) => !w.allowedTargets.some((a) => same(a, t.token))).map((t) => t.sym);
    if (lacking.length) {
      blockers.push(`the owner's EVM window does not allow ${lacking.join(", ")}`);
      reopen = true;
    }
  }
  return { cost, blockers, command: reopen ? windowCommand(s.cfg.owner) : null };
}

export type TurnOffStepId = "approvals" | "unlink" | "agent";
export type TurnOffStep = { id: TurnOffStepId; done: boolean };

/** Whether the agent answered the card's own /health poll; "unknown" until the first answer or failure. */
export type AgentReach = "online" | "offline" | "unknown";

/**
 * Where turning off stands, from chain reads (undefined = not read yet, never done) and the agent's /health. "unlink"
 * is done when no live key is linked at all: /config carries no agent key, so any live key keeps it open.
 */
export function turnOffSteps(i: {
  allowances: Allowances | undefined;
  authenticators: Pick<AuthenticatorView, "revoked" | "expiryUnix">[] | undefined;
  agent: AgentReach;
  nowUnix: number;
}): TurnOffStep[] {
  return [
    { id: "approvals", done: !!i.allowances && TOKEN_SYMBOLS.every((sym) => i.allowances![sym] === 0n) },
    { id: "unlink", done: !!i.authenticators && !hasLiveAuthenticator(i.authenticators, i.nowUnix) },
    { id: "agent", done: i.agent === "offline" },
  ];
}

export const unlinkCommand = (owner: string): string => `pnpm cli unlink --expect ${owner}`;
