import type { HostedStatus, OwnerPublicState, TokenSymbol } from "@qday/core";
import type { PqcStatus } from "@qorechain/sdk";
import { getContractAddress, maxUint256, type Hex } from "viem";
import { fmtUqor } from "./format";

/** The self-serve journey. Steps 1-7 are onboarding (Task 9); `attack`, `withdraw` and `done` follow. */
export type JourneyStep = "account" | "code" | "starter" | "register" | "guardian" | "vault" | "protect" | "attack" | "withdraw" | "done";

/** The starter pack is 2.5 QOR; the journey moves on once at least this much has arrived. */
export const STARTER_MIN_UQOR = 2_000_000n;

/**
 * Everything the journey position is read from. `undefined` means still reading: it never counts as done (same
 * convention as `lib/protect.ts`). `vault`: `owner()`/`guardian()` of this owner's vault, `null` when it has none.
 */
export type OnboardInput = {
  hasSeed: boolean;
  codeConfirmed: boolean;
  uqor: bigint | undefined;
  pqc: PqcStatus | undefined;
  state: OwnerPublicState | undefined;
  vault: { owner: Hex; guardian: Hex } | null | undefined;
  allowances: Record<TokenSymbol, bigint> | undefined;
  linked: boolean | undefined;
  ruleExact: boolean | undefined;
  /**
   * fUSD, fETH and fBTC the owner holds, account + vault. A token at 0 was never minted (a vault step cut short), so
   * protect mints it again. Optional; undefined (still reading) never holds up the activation.
   */
  holdings?: Record<TokenSymbol, bigint>;
};

export type OnboardPosition = { step: JourneyStep; detail: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const SYMBOLS: TokenSymbol[] = ["fUSD", "fETH", "fBTC"];

/**
 * Where the journey stands, from chain and service reads only (never from a click), so a reopened tab resumes where
 * the chain says: after the vault deploy it is `protect`, never `vault` again; once a guardian is provisioned it is
 * never `guardian` again.
 */
export function nextOnboardStep(i: OnboardInput): OnboardPosition {
  if (!i.hasSeed) return { step: "account", detail: "create your wallet in this browser" };

  const registered = i.pqc?.registered === true;
  // A registered key means the code was confirmed in an earlier session (the local flag can be lost with storage).
  if (!i.codeConfirmed && !registered) {
    return { step: "code", detail: i.pqc === undefined ? "reading whether your post-quantum key is registered" : "write down your recovery code and confirm it" };
  }

  if (i.state === undefined) return { step: "starter", detail: "reading your starter pack from the service" };
  if (i.state.stage === "none") return { step: "starter", detail: "get your starter pack: 2.5 QOR from the service" };

  if (!registered) {
    if (i.pqc === undefined) return { step: "starter", detail: "reading whether your post-quantum key is registered" };
    if (i.uqor === undefined) return { step: "starter", detail: "reading your QOR balance" };
    if (i.uqor < STARTER_MIN_UQOR) return { step: "starter", detail: `starter pack sent, waiting for it to arrive (${fmtUqor(i.uqor)} of ${fmtUqor(STARTER_MIN_UQOR)} QOR)` };
    return { step: "register", detail: "register your post-quantum key on chain" };
  }
  if (i.pqc!.possessionProven !== true) {
    return { step: "register", detail: "this account's post-quantum key is registered without a proof of possession: it can't be protected" };
  }

  if (i.state.stage === "starter") return { step: "guardian", detail: "get your Guardian from the service" };
  const guardian = i.state.guardian;
  if (!guardian) return { step: "guardian", detail: "the service names no guardian for this account yet" };

  if (i.vault === undefined) return { step: "vault", detail: "looking for your vault on chain (reading)" };
  if (i.vault === null) return { step: "vault", detail: "create your vault and mint your test tokens" };
  if (!same(i.vault.guardian, guardian)) {
    return { step: "vault", detail: `the vault found names guardian ${i.vault.guardian}, not your Guardian ${guardian}: it can't be used` };
  }

  if (i.allowances === undefined || i.linked === undefined || i.ruleExact === undefined) {
    return { step: "protect", detail: "reading your approvals and the Guardian's link" };
  }
  const allowances = i.allowances;
  const open = SYMBOLS.filter((s) => allowances[s] !== maxUint256);
  const missing: string[] = [];
  const holdings = i.holdings;
  const unminted = holdings ? SYMBOLS.filter((s) => holdings[s] === 0n) : [];
  const preActive = i.state.stage !== "active" && i.state.stage !== "retired";
  if (preActive && unminted.length) missing.push(`mint ${unminted.join(", ")}`);
  if (open.length) missing.push(`approve ${open.join(", ")} for the vault`);
  if (!i.linked) missing.push("link your Guardian");
  else if (!i.ruleExact) missing.push("set the Guardian's rule to vault.rescue only");
  if (missing.length) return { step: "protect", detail: missing.join(" and ") };
  if (preActive) return { step: "protect", detail: "approvals and link are on chain: activate your Guardian" };

  return { step: "attack", detail: "protection is on" };
}

/**
 * Whether a wallet whose recovery code was lost before it was confirmed may be replaced by a new one: only while the
 * service has handed it nothing and no key is registered (both read, never assumed), so nothing is abandoned.
 */
export function canStartOver(state: OwnerPublicState | undefined, pqc: PqcStatus | undefined): boolean {
  return state?.stage === "none" && pqc?.registered === false;
}

export type ProtectWindowPlan = { mint: TokenSymbol[]; approve: TokenSymbol[]; txs: number; scope: Hex[] };

/**
 * The protect step's EVM txs, all to token contracts: `mint` for each token the owner holds none of (account + vault,
 * so tokens a rescue moved into the vault never count as missing), then `approve(vault, max)` for each open allowance.
 * The window holds exactly these txs and is scoped to exactly the tokens they touch.
 */
export function protectWindowPlan(
  allowances: Record<TokenSymbol, bigint>,
  owned: Record<TokenSymbol, bigint>,
  tokens: Record<TokenSymbol, string>,
  inVault: Record<TokenSymbol, bigint> = { fUSD: 0n, fETH: 0n, fBTC: 0n },
): ProtectWindowPlan {
  const mint = SYMBOLS.filter((s) => owned[s] + inVault[s] === 0n);
  const approve = SYMBOLS.filter((s) => allowances[s] !== maxUint256);
  const scope = SYMBOLS.filter((s) => mint.includes(s) || approve.includes(s)).map((s) => tokens[s] as Hex);
  return { mint, approve, txs: mint.length + approve.length, scope };
}

/** Whether the landing page's "Get started" works, and why not. Closed until the service says it is open. */
export function landingStart(status: HostedStatus | undefined, error: string | null): { enabled: boolean; reason: string | null } {
  if (!status) return { enabled: false, reason: error ? `The onboarding service is not reachable right now (${error}).` : "Checking whether onboarding is open…" };
  if (status.onboarding === "open") return { enabled: true, reason: null };
  const why =
    status.reason === "funder-low"
      ? "the service is low on the testnet QOR it hands out. Try again later."
      : status.reason === "daily-cap"
        ? "today's starter packs are all handed out. Try again tomorrow (UTC)."
        : status.reason === "no-funder"
          ? "the service has no funding wallet set up yet."
          : status.reason === "chain-unreachable"
            ? "the diana testnet is not answering right now. Try again in a few minutes."
            : `${status.reason ?? "no reason given"}.`;
  return { enabled: false, reason: `Onboarding is paused: ${why}` };
}

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const codeKey = (owner: string) => `qlifeboat.codeConfirmed.v1.${owner.toLowerCase()}`;

/** Whether the owner confirmed their recovery code in this browser. Only a flag: the code itself is never stored. */
export function loadCodeConfirmed(storage: KV | undefined, owner: string): boolean {
  try {
    return storage?.getItem(codeKey(owner)) === "1";
  } catch {
    return false;
  }
}

export function saveCodeConfirmed(storage: KV | undefined, owner: string): void {
  try {
    storage?.setItem(codeKey(owner), "1");
  } catch {
    // private mode / quota: a registered key also passes the code step
  }
}

/** How many of the owner's own tx nonces `locateVault` checks for a contract it created. */
export const VAULT_PROBE_NONCES = 16;

export type LocateVaultDeps = {
  /** The owner's tx count (its next nonce). */
  txCount(owner: Hex): Promise<number>;
  /** `owner()`/`guardian()` at an address; null when no GuardianVault is there. Throws on transport errors. */
  roles(address: Hex): Promise<{ owner: Hex; guardian: Hex } | null>;
};

/**
 * This owner's vault for `guardian`: the one saved in this browser, else the one the service recorded, else a contract
 * the owner created at one of its first nonces (the deploy's address is fixed by sender + nonce), so a lost browser
 * storage never leads to a second deploy. Only a vault whose `owner()` and `guardian()` match is returned. A read
 * error propagates: "could not read" must never look like "no vault".
 */
export async function locateVault(
  w: { owner: Hex; guardian: Hex; stored: string | null; hosted: string | undefined },
  deps: LocateVaultDeps,
): Promise<{ address: Hex; roles: { owner: Hex; guardian: Hex } } | null> {
  const fits = (r: { owner: Hex; guardian: Hex } | null) => !!r && same(r.owner, w.owner) && same(r.guardian, w.guardian);
  const tried = new Set<string>();
  for (const a of [w.stored, w.hosted]) {
    if (!a || tried.has(a.toLowerCase())) continue;
    tried.add(a.toLowerCase());
    const r = await deps.roles(a as Hex);
    if (fits(r)) return { address: a as Hex, roles: r! };
  }
  const n = Math.min(await deps.txCount(w.owner), VAULT_PROBE_NONCES);
  for (let nonce = 0; nonce < n; nonce++) {
    const a = getContractAddress({ from: w.owner, nonce: BigInt(nonce) });
    if (tried.has(a.toLowerCase())) continue;
    const r = await deps.roles(a);
    if (fits(r)) return { address: a, roles: r! };
  }
  return null;
}

/**
 * The action state to keep when the shown step changes. A running action is kept: the journey can move on under it
 * (the vault shows on chain while the vault step's mints still run), and clearing it would enable the next step's
 * button while the window and the account sequence are still in use. A finished or failed one is cleared.
 */
export function runOnStepChange<R extends { state: string }>(run: R, idle: R): R {
  return run.state === "busy" ? run : idle;
}
