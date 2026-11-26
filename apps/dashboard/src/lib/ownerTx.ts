import { buildOnboardWindowParams, type OwnerPublicState } from "@qday/core";
import { openEvmWindowMsg, type UnifiedAccount } from "@qorechain/sdk";
import type { Account, Chain, Hex, Transport, WalletClient } from "viem";

/** A cosmos message as the SDK builders return it (an `EncodeObject`). */
export type Msg = { typeUrl: string; value: unknown };

/** A viem wallet with the owner's classical key as a local account, on diana. */
export type OwnerWallet = WalletClient<Transport, Chain, Account>;

/**
 * Every owner window the app opens lasts 600 blocks (~14 min at 1.4 s) and holds exactly the txs it is about to send,
 * so a used-up window shows closed (chain fact 20) without a close tx. The Guardian is armed for the same span.
 */
export const OWNER_WINDOW_BLOCKS = 600;
/** How long to wait for a delivered window to show live on REST. */
const LIVE_TRIES = 20;
const LIVE_DELAY_MS = 1_000;

export type OwnerWindowRequest = {
  /** Exactly the number of EVM txs `run` sends. */
  txs: number;
  /** "unscoped" only for contract creation (a window with targets refuses it, chain fact 10). */
  scope: "unscoped" | Hex[];
  /** Value headroom for a QOR send (a window counts value in its budget, chain fact 19). */
  topupUqor?: bigint;
  /** Sent in the same hybrid tx as the window, after it (e.g. the Guardian's link). */
  extraMsgs?: Msg[];
};

export type OwnerTxDeps = {
  /** Sign hybrid (secp256k1 + ML-DSA-87) and broadcast; resolves to the tx hash once delivered, throws when refused. */
  broadcast(acc: UnifiedAccount, msgs: Msg[], memo: string): Promise<string>;
  /** The owner's stage at the hosted service. */
  ownerStage(owner: Hex): Promise<OwnerPublicState["stage"]>;
  /** Arm the owner's Guardian for `blocks` (signed `arm`); resolves once its window is live. */
  arm(acc: UnifiedAccount, blocks: number): Promise<void>;
  /** Whether the owner's EVM window is live (REST). */
  windowLive(acc: UnifiedAccount): Promise<boolean>;
  wallet(acc: UnifiedAccount): OwnerWallet;
  sleep(ms: number): Promise<void>;
};

const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** The window message: the onboarding budget (per-tx fee budget × txs + top-up), scoped to exactly `scope` unless unscoped. */
export function ownerWindowMsg(cosmos: string, w: Pick<OwnerWindowRequest, "txs" | "scope" | "topupUqor">): Msg {
  if (!Number.isSafeInteger(w.txs) || w.txs < 1) throw new Error(`a window needs a positive whole number of txs, got ${w.txs}`);
  const params = buildOnboardWindowParams(cosmos, { blocks: OWNER_WINDOW_BLOCKS, txs: w.txs, topupUqor: w.topupUqor ?? 0n });
  if (w.scope === "unscoped") return openEvmWindowMsg(params);
  // An empty list would open an UNSCOPED window (any recipient): refuse it rather than widen the window by accident.
  if (!w.scope.length) throw new Error("a scoped window needs at least one target; pass scope: \"unscoped\" to mean any recipient");
  const bad = w.scope.filter((a) => !isAddress(a));
  if (bad.length) throw new Error(`window scope holds a non-address: ${bad.join(", ")}`);
  if (new Set(w.scope.map((a) => a.toLowerCase())).size !== w.scope.length) throw new Error(`window scope contains a duplicate address: ${w.scope.join(", ")}`);
  return openEvmWindowMsg({ ...params, allowedTargets: [...w.scope] });
}

export function createOwnerTx(deps: OwnerTxDeps) {
  async function sendHybrid(acc: UnifiedAccount, msgs: Msg[], memo: string): Promise<string> {
    if (!msgs.length) throw new Error("no messages to send");
    return deps.broadcast(acc, msgs, memo);
  }

  /**
   * Open a window of exactly `w.txs` txs and 600 blocks, run `run` inside it, return the hashes. When the owner's
   * Guardian is active (or retired) it is armed FIRST (spec §6.7): the Guardian's window is live before the owner's opens. Before
   * activation there is no agent to arm. Any failure before the window tx (stage read, arm, a bad request) opens nothing.
   */
  async function withOwnerWindow(
    acc: UnifiedAccount,
    w: OwnerWindowRequest,
    run: (wallet: OwnerWallet) => Promise<Hex[]>,
  ): Promise<{ windowTx: string; txs: Hex[] }> {
    const windowMsg = ownerWindowMsg(acc.cosmos, w); // validates before anything is read or sent
    const stage = await deps.ownerStage(acc.evm as Hex);
    // A retired owner is armed too: the gateway re-funds and restarts its Guardian first (spec §6.7).
    if (stage === "active" || stage === "retired") await deps.arm(acc, OWNER_WINDOW_BLOCKS);
    const memo = w.extraMsgs?.length ? "qlifeboat: owner window + guardian link" : "qlifeboat: owner window";
    const windowTx = await sendHybrid(acc, [windowMsg, ...(w.extraMsgs ?? [])], memo);
    let live = false;
    for (let i = 0; i < LIVE_TRIES && !live; i++) {
      if (i) await deps.sleep(LIVE_DELAY_MS);
      live = await deps.windowLive(acc);
    }
    if (!live) throw new Error(`the window opened in tx ${windowTx} does not show live yet; reload and try again`);
    const txs = await run(deps.wallet(acc));
    return { windowTx, txs };
  }

  return { sendHybrid, withOwnerWindow };
}

export type OwnerTx = ReturnType<typeof createOwnerTx>;
