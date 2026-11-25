import { NETWORK, ruleIsExact } from "@qday/core";
import { evmWindowCost } from "@qorechain/evm/window";
import type { AuthenticatorView, PqcStatus, SpendingRules } from "@qorechain/sdk";
import { maxUint256, type Hex } from "viem";
import { senderBlockers, type Sender, type WindowView } from "./actions";
import type { Health, Policy } from "./agent";
import type { AgentConfig } from "./config";
import { shortAddr } from "./format";

/**
 * Tight gas limits (chain fact 5): the vault deploy used 725168 gas on diana (`DEPLOY_GAS` in apps/cli/src/fresh.ts),
 * an `approve` far less (`APPROVE_GAS` in apps/cli/src/setup.ts).
 */
export const DEPLOY_GAS = 950_000n;
export const APPROVE_GAS = 100_000n;
/** A linked agent key that expires this soon counts as not linked (same margin as `setup`). */
const EXPIRY_MARGIN_SECONDS = 60;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lc = (s: string) => s.toLowerCase();
const same = (a: string, b: string) => lc(a) === lc(b);

export type StepId = "connect" | "vault" | "approve" | "guardian" | "trusted" | "recovery";
export type StepState = "done" | "current" | "todo" | "blocked";
export type ProtectStep = { id: StepId; state: StepState; detail: string };

/** Local choices the owner makes in the dashboard (per owner, browser storage). */
export type ProtectState = { vault: string | null; recovery: string | null; trustedReviewed: boolean };

/**
 * Already-read values. `undefined` means still loading: it never counts as done and never as blocked. `null` means
 * read and absent (no wallet, no vault yet, no agent config).
 */
export type ProtectInput = {
  wallet: string | null;
  chainId: number | null;
  pqc: PqcStatus | undefined;
  /** The vault address the screen works with: the remembered one, or the agent config's when it names this owner. */
  vault: string | null;
  /** `owner()` and `guardian()` read from `vault` on chain. */
  vaultRoles: { owner: string; guardian: string } | undefined;
  /** The wallet's allowance to `vault` per token. */
  allowances: { fUSD: bigint; fETH: bigint; fBTC: bigint } | undefined;
  authenticators: AuthenticatorView[] | undefined;
  rules: SpendingRules | undefined;
  /** The agent's /config (its `guardian` is the expected guardian). `null`: the agent gave none. */
  config: AgentConfig | null | undefined;
  /** `checkConfigOnChain(config, vaultRoles)`. */
  configCheck: { ok: boolean; detail: string } | undefined;
  online: boolean | undefined;
  health: Health | undefined;
  policy: Policy | undefined;
  local: ProtectState;
  nowUnix: number;
  /** The connected wallet's EVM window (`undefined`: still reading). */
  window: WindowView | undefined;
};

/** A step's verdict before positions are assigned: `loading` reads are never blocked. */
type Verdict = { done: boolean; blocked?: boolean; detail: string };

const joinParts = (parts: string[]) => parts.join("; ");

function connectStep(i: ProtectInput): Verdict {
  if (!i.wallet) return { done: false, detail: "connect your wallet (MetaMask)" };
  if (i.chainId !== NETWORK.evmChainId) return { done: false, detail: `switch the wallet to diana (${NETWORK.evmChainId})` };
  if (!i.pqc) return { done: false, detail: "reading the account's post-quantum key" };
  if (!i.pqc.registered) {
    return { done: false, blocked: true, detail: "this account has no ML-DSA-87 key: register one first (a demo owner: `pnpm cli fresh-owner --no-vault`)" };
  }
  if (i.pqc.possessionProven !== true) {
    return { done: false, blocked: true, detail: "the account's ML-DSA-87 key has no proof of possession: register it again with one" };
  }
  return { done: true, detail: `${shortAddr(i.wallet)} on diana, post-quantum key registered` };
}

/** Shown when the agent is not running: it can start before this owner has a vault. */
export const START_AGENT_HINT =
  "start the agent: its /config names the guardian. It can run with the root .env before this owner has a vault (any running agent serves the guardian address)";

/**
 * Steps after "connect" need it done: without a registered, possession-proven ML-DSA-87 key a vault would let a holder of
 * a leaked ECDSA key register THEIR key (a classically signed MsgRegisterPQCKeyV2) and withdraw what is rescued.
 */
const afterConnect = (connect: Verdict): Verdict | null => (connect.done ? null : { done: false, blocked: true, detail: `finish step 1 first: ${connect.detail}` });

function vaultStep(i: ProtectInput, connect: Verdict): Verdict {
  const gate = afterConnect(connect);
  if (gate) return gate;
  if (!i.wallet) return { done: false, detail: "connect your wallet to create or check the vault" };
  if (i.config === undefined) return { done: false, detail: "reading the agent's /config for the guardian" };
  if (i.config === null) return { done: false, blocked: true, detail: START_AGENT_HINT };
  const guardian = i.config.guardian;
  if (!i.vault) return { done: false, detail: `deploy a vault owned by ${i.wallet} with guardian ${guardian}` };
  if (!i.vaultRoles) return { done: false, detail: `reading the owner and guardian of vault ${i.vault}` };
  const bad: string[] = [];
  if (!same(i.vaultRoles.owner, i.wallet)) bad.push(`owner is ${i.vaultRoles.owner}, your wallet is ${i.wallet}`);
  if (!same(i.vaultRoles.guardian, guardian)) bad.push(`guardian is ${i.vaultRoles.guardian}, the agent's guardian is ${guardian}`);
  if (bad.length) return { done: false, blocked: true, detail: `vault ${i.vault} on chain: ${bad.join("; ")}. It can't be used: owner and guardian are immutable` };
  return { done: true, detail: `vault ${i.vault}: owner and guardian match on chain` };
}

/**
 * What differs between a vault's on-chain `owner()`/`guardian()` and the wanted ones; empty means the vault may be
 * remembered. The screen calls this on the roles it READ back after a deploy or for an address the owner typed.
 */
export function vaultRoleProblems(roles: { owner: string; guardian: string }, want: { owner: string; guardian: string }): string[] {
  const out: string[] = [];
  if (!same(roles.owner, want.owner)) out.push(`its owner is ${roles.owner}, not your wallet ${want.owner}`);
  if (!same(roles.guardian, want.guardian)) out.push(`its guardian is ${roles.guardian}, not the agent's guardian ${want.guardian}`);
  return out;
}

/** Why the steps that need the vault can't run yet, or null when the vault step is done. */
const needVault = (i: ProtectInput, vaultDone: boolean, connect: Verdict): string | null =>
  vaultDone ? null : !connect.done ? `finish step 1 first: ${connect.detail}` : i.vault ? "fix the vault step first" : "create the vault first";

function approveStep(i: ProtectInput, vaultDone: boolean, connect: Verdict): Verdict {
  const need = needVault(i, vaultDone, connect);
  if (need) return { done: false, detail: need };
  if (!i.allowances) return { done: false, detail: "reading your token allowances to the vault" };
  const open = (Object.keys(i.allowances) as (keyof typeof i.allowances)[]).filter((k) => i.allowances![k] !== maxUint256);
  if (open.length) return { done: false, detail: `approve ${open.join(", ")} for the vault (${3 - open.length} of 3 approved)` };
  return { done: true, detail: "fUSD, fETH and fBTC approved for the vault" };
}

/**
 * The unscoped window `window open --onboard` opens (live, no `allowedTargets`) lets a leaked ECDSA key send value to
 * any address until it closes, so the account is not protected while it is open.
 */
export const onboardingWindowOpen = (w: WindowView | undefined): boolean => !!w && w.live && w.allowedTargets.length === 0;

/** The env a CLI command that signs for the owner needs: tsx --env-file would otherwise fill in the root .env's vault. */
export const ownerEnvNote = (vault: string): string => `Load this owner's run.env (OWNER_MNEMONIC) and export VAULT_ADDRESS=${vault}`;

export { ruleIsExact };

/** An agent key that is linked, not revoked and not about to expire (same margin as `setup`). */
export const hasLiveAuthenticator = (list: Pick<AuthenticatorView, "revoked" | "expiryUnix">[], nowUnix: number): boolean =>
  list.some((a) => !a.revoked && a.expiryUnix > BigInt(nowUnix + EXPIRY_MARGIN_SECONDS));

function guardianStep(i: ProtectInput, vaultDone: boolean, connect: Verdict): Verdict {
  const need = needVault(i, vaultDone, connect);
  if (need) return { done: false, detail: need };
  const vault = i.vault!;
  const missing: string[] = [];
  const reading: string[] = [];

  if (!i.authenticators) reading.push("the linked keys");
  else if (!hasLiveAuthenticator(i.authenticators, i.nowUnix)) {
    missing.push("link the agent key (`pnpm cli link`): none is linked, or it is revoked or about to expire");
  }
  if (!i.rules) reading.push("the spending rule");
  else if (!ruleIsExact(i.rules, vault)) missing.push("the agent's spending rule is not exactly vault.rescue with uqor only");

  if (i.online === undefined) reading.push("the agent");
  else if (!i.online) missing.push("the agent is not running (`pnpm agent`)");
  else {
    if (i.config === null) missing.push("the agent gave no /config");
    else if (i.config) {
      if (i.wallet && !same(i.config.owner, i.wallet)) missing.push(`the agent's /config names another owner (${i.config.owner})`);
      if (!same(i.config.vault, vault)) missing.push(`the agent's /config names another vault (${i.config.vault})`);
    }
    if (!i.configCheck) reading.push("the agent's config check");
    else if (!i.configCheck.ok) missing.push(`the agent's config does not match the chain: ${i.configCheck.detail}`);
    if (!i.health) reading.push("the agent's health");
    else if (i.health.gas.low) missing.push("the guardian's gas tank is low: top it up");
  }

  if (!i.window) reading.push("the EVM window");
  else if (onboardingWindowOpen(i.window)) missing.push(`close the onboarding window, it is unscoped (\`pnpm cli window close --expect ${i.wallet}\`)`);

  if (missing.length || reading.length) {
    return { done: false, detail: joinParts([...missing, ...(reading.length ? [`reading ${reading.join(", ")}`] : [])]) };
  }
  return { done: true, detail: "agent key linked, rule is vault.rescue only, agent online with gas" };
}

function trustedStep(i: ProtectInput): Verdict {
  if (i.policy && i.policy.trusted.length > 0) return { done: true, detail: `${i.policy.trusted.length} trusted address(es) saved` };
  if (i.local.trustedReviewed) return { done: true, detail: "trusted list reviewed" };
  if (!i.policy) return { done: false, detail: i.online === false ? "start the agent to read the trusted list" : "reading the trusted list" };
  return { done: false, detail: "add the wallets and apps you send to, or mark the list as reviewed" };
}

function recoveryStep(i: ProtectInput): Verdict {
  const r = i.local.recovery;
  if (r && ADDRESS_RE.test(r)) return { done: true, detail: `recovery address ${r}` };
  return { done: false, detail: "save an address that only you control for withdrawals from the vault" };
}

/**
 * The six Protect steps. Each state comes from the reads in `input` (chain or agent), never from a click, except the
 * trusted-list review and the recovery address, which are local choices. The first not-done step is `current` (or
 * `blocked` when it can't proceed); later not-done steps are `todo`; a later step already satisfied stays `done`.
 */
export function protectSteps(i: ProtectInput): ProtectStep[] {
  const connect = connectStep(i);
  const vault = vaultStep(i, connect);
  const verdicts: [StepId, Verdict][] = [
    ["connect", connect],
    ["vault", vault],
    ["approve", approveStep(i, vault.done, connect)],
    ["guardian", guardianStep(i, vault.done, connect)],
    ["trusted", trustedStep(i)],
    ["recovery", recoveryStep(i)],
  ];
  let first = true;
  return verdicts.map(([id, v]) => {
    if (v.done) return { id, state: "done", detail: v.detail };
    const state: StepState = first ? (v.blocked ? "blocked" : "current") : "todo";
    first = false;
    return { id, state, detail: v.detail };
  });
}

/** A recovery address must be an address the owner doesn't already trust the agent or a thief with: not owner, vault or guardian. */
export function validateRecovery(
  input: string,
  who: { owner: string; vault: string; guardian: string },
): { ok: true; address: Hex } | { ok: false; error: string } {
  const a = input.trim();
  if (!ADDRESS_RE.test(a)) return { ok: false, error: "enter a 0x address (0x + 40 hex characters)" };
  if (same(a, who.owner)) return { ok: false, error: "that is your own account: a leaked key controls it" };
  if (same(a, who.vault)) return { ok: false, error: "that is the vault itself" };
  if (same(a, who.guardian)) return { ok: false, error: "that is the guardian: the agent's own account" };
  return { ok: true, address: a as Hex };
}

export type Command = { command: string; note: string };

/** The CLI lines Protect shows. Each has a one-line note on the environment it needs (plain text, no secrets). */
export function protectCommands(owner: string, vault: string): { window: Command; link: Command; agent: Command } {
  return {
    window: {
      command: `pnpm cli window open --onboard --expect ${owner}`,
      note: "Load this owner's run.env (OWNER_MNEMONIC) first; the command refuses another account.",
    },
    link: {
      command: `pnpm cli link --expect ${owner}`,
      note: `Load this owner's run.env (OWNER_MNEMONIC, AGENT_ED25519_SK) and export VAULT_ADDRESS=${vault}`,
    },
    agent: {
      command: "pnpm agent",
      note: `Load this owner's run.env (OWNER_EVM_ADDRESS=${owner}, AGENT_ED25519_SK) and export VAULT_ADDRESS=${vault}; stop any other agent on :8787 first`,
    },
  };
}

/**
 * Recover's warning when the loaded withdrawal pays an address other than the recovery address the owner saved, or
 * null (also when none is saved).
 */
export function recoveryWarning(to: string, recovery: string | null): string | null {
  if (!recovery || same(to, recovery)) return null;
  return `This withdrawal pays ${to}, not your saved recovery address ${recovery}. Check it is the address you mean before you submit.`;
}

/**
 * Whether the vault step offers "Deploy": only with no vault in use, or one that is blocked (roles differ). While the
 * roles of a vault in use are loading it is "checking"; when they can't be read it is "error" (retry or forget it):
 * either way a second click would deploy a second vault and overwrite the first.
 */
export function deployOffer(i: { vault: string | null; vaultState: StepState; rolesLoaded: boolean; rolesError: boolean }): "offer" | "checking" | "done" | "error" {
  if (!i.vault) return "offer";
  if (i.vaultState === "done") return "done";
  if (i.vaultState === "blocked") return "offer";
  if (!i.rolesLoaded && i.rolesError) return "error"; // never a second deploy over a vault we could not read
  return "checking";
}

/** Signs a withdrawal from the vault to the recovery address with the local Guardian Signer. */
export const signWithdrawCommand = (recovery: string, token: string, amount: string): string => `pnpm cli sign-withdraw ${recovery} ${token} ${amount}`;

/** The wallet's view of the owner's EVM window plus the network fee, as the planners need them. */
export type OnboardSender = { wallet: string | null; chainId: number | null; window: WindowView | undefined; maxFeePerGas: bigint | undefined };
export type OnboardPlan = { cost: bigint; blockers: string[]; command: string | null };

const onboardCommand = (wallet: string | null) => (wallet ? `pnpm cli window open --onboard --expect ${wallet}` : null);

/** The window checks of `planRescueNow`, for a wallet that is the owner by definition (no vault or agent config yet). */
function windowBlockers(s: OnboardSender, n: bigint, cost: bigint): { blockers: string[]; reopen: boolean } {
  const sender: Sender = {
    cfg: { owner: (s.wallet ?? "0x") as Hex, vault: "0x", guardian: "0x" }, // only `owner` is read, and only with a wallet
    configOk: true,
    wallet: s.wallet,
    chainId: s.chainId,
    window: s.window,
    maxFeePerGas: s.maxFeePerGas,
  };
  return senderBlockers(sender, "", null, n, cost);
}

/**
 * Deploying the vault from the wallet: one contract-creation tx, which a window with `allowedTargets` refuses, so the
 * window must be live AND unscoped, with a tx and the budget for `DEPLOY_GAS` at the read fee cap left.
 */
export function planDeploy(s: OnboardSender): OnboardPlan {
  const cost = s.maxFeePerGas === undefined ? 0n : evmWindowCost({ gas: DEPLOY_GAS, maxFeePerGas: s.maxFeePerGas });
  const { blockers, reopen: r } = windowBlockers(s, 1n, cost);
  let reopen = r;
  if (s.window?.live && s.window.allowedTargets.length) {
    blockers.push("the owner's EVM window is scoped to named addresses, which refuses contract creation: open an unscoped one");
    reopen = true;
  }
  return { cost, blockers, command: reopen ? onboardCommand(s.wallet) : null };
}

export const TOKEN_SYMBOLS = ["fUSD", "fETH", "fBTC"] as const;
export type ApproveToken = { sym: string; token: string };

/** One approve tx per token whose allowance to the vault is not the maximum. */
export function tokensToApprove(allowances: { fUSD: bigint; fETH: bigint; fBTC: bigint }, tokens: { fUSD: string; fETH: string; fBTC: string }): ApproveToken[] {
  return TOKEN_SYMBOLS.filter((sym) => allowances[sym] !== maxUint256).map((sym) => ({ sym, token: tokens[sym] }));
}

/**
 * `approve(vault, max)` for each token: n window txs and `n x APPROVE_GAS` of budget. A window with targets must list
 * every token. A closed or too-small window yields the `--onboard` command.
 */
export function planApprove(s: OnboardSender & { tokens: ApproveToken[] }): OnboardPlan {
  if (!s.tokens.length) return { cost: 0n, blockers: ["nothing to approve: the vault already has the maximum allowance"], command: null };
  const n = BigInt(s.tokens.length);
  const cost = s.maxFeePerGas === undefined ? 0n : n * evmWindowCost({ gas: APPROVE_GAS, maxFeePerGas: s.maxFeePerGas });
  const { blockers, reopen: r } = windowBlockers(s, n, cost);
  let reopen = r;
  const w = s.window;
  if (w?.live && w.allowedTargets.length) {
    const lacking = s.tokens.filter((t) => !w.allowedTargets.some((a) => same(a, t.token))).map((t) => t.sym);
    if (lacking.length) {
      blockers.push(`the owner's EVM window does not allow ${lacking.join(", ")}`);
      reopen = true;
    }
  }
  return { cost, blockers, command: reopen ? onboardCommand(s.wallet) : null };
}

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const stateKey = (owner: string) => `qday.protect.v1.${lc(owner)}`;
const EMPTY_STATE: ProtectState = { vault: null, recovery: null, trustedReviewed: false };
const addressOrNull = (v: unknown): string | null => (typeof v === "string" && ADDRESS_RE.test(v) ? v : null);

/** The owner's saved choices. Missing or blocked storage and malformed JSON read as the empty state. */
export function loadProtectState(storage: KV | undefined, owner: string): ProtectState {
  try {
    const raw = storage?.getItem(stateKey(owner));
    if (!raw) return { ...EMPTY_STATE };
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null || Array.isArray(o)) return { ...EMPTY_STATE };
    const r = o as Record<string, unknown>;
    return { vault: addressOrNull(r.vault), recovery: addressOrNull(r.recovery), trustedReviewed: r.trustedReviewed === true };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function saveProtectState(storage: KV | undefined, owner: string, state: ProtectState): void {
  try {
    storage?.setItem(stateKey(owner), JSON.stringify(state));
  } catch {
    // private mode / quota: the choices are a convenience only
  }
}
