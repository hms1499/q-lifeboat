import { broadcastTx } from "@qday/core/chain";
import { NETWORK } from "@qday/core";
import { evmWindowCost, evmWindowStatus, type EvmWindow } from "@qorechain/evm";
import { openEvmWindowMsg } from "@qorechain/sdk";
import type { Hex } from "viem";
import type { AgentConfig } from "./config";
import { RESCUE_GAS } from "./rescue";

/**
 * The guardian account's own EVM window. The agent sends `vault.rescue` as plain EVM txs, which the chain
 * admits only inside a window opened by a hybrid-signed (ECDSA + ML-DSA-87) native-lane message. The window
 * is scoped to the vault alone, so a leaked guardian ECDSA key can only call the vault.
 */
const WINDOW_BLOCKS = 600;
const WINDOW_MAX_TXS = 10;
const WINDOW_MAX_FEE_PER_GAS = 112_500_000_000n;
const MIN_BLOCKS = 100n;
const MIN_TXS = 3n;
/** What one rescue tx can take from the window, in uqor. */
const RESCUE_TX_COST = evmWindowCost({ gas: RESCUE_GAS, maxFeePerGas: WINDOW_MAX_FEE_PER_GAS });

export type WindowStatus = Pick<EvmWindow, "live" | "remainingBlocks" | "remainingTxs" | "remainingValue">;

/** True when the window cannot be relied on for a 3-token rescue: not live, or low on blocks, txs or value. */
export function needsWindow(s: WindowStatus): boolean {
  return !s.live || s.remainingBlocks < MIN_BLOCKS || s.remainingTxs < MIN_TXS || s.remainingValue < RESCUE_TX_COST * MIN_TXS;
}

/** `MsgOpenEVMWindow` parameters: 600 blocks, 10 txs, budget for 10 rescue txs, the vault as the only target. */
export function buildGuardianWindowParams(guardianCosmos: string, vault: Hex) {
  return {
    sender: guardianCosmos,
    blocks: WINDOW_BLOCKS,
    maxTxs: WINDOW_MAX_TXS,
    maxValue: (RESCUE_TX_COST * BigInt(WINDOW_MAX_TXS)).toString(),
    allowedTargets: [vault],
  };
}

export type WindowDeps = {
  readStatus(): Promise<WindowStatus>;
  /** Broadcast `MsgOpenEVMWindow` (replaces an unexpired window); resolves with the tx hash once delivered. */
  open(): Promise<string>;
  log(line: string): void;
};

export type WindowKeeper = ReturnType<typeof createWindowKeeper>;

export function createWindowKeeper(deps: WindowDeps) {
  let cached: WindowStatus | undefined;

  /** Read the window; if it is not usable, open ONE new window and check it. Throws when it stays unusable. */
  async function ensure(): Promise<void> {
    cached = await deps.readStatus();
    if (!needsWindow(cached)) return;
    const hash = await deps.open();
    deps.log(`guardian window opened: ${hash}`);
    cached = await deps.readStatus();
    if (needsWindow(cached)) throw new Error(`guardian window still not usable after opening (tx ${hash})`);
  }

  return {
    ensure,
    /** Before a rescue: no REST read when the cached status says the window is usable. */
    async ensureIfStale(): Promise<void> {
      if (cached && !needsWindow(cached)) return;
      await ensure();
    },
    /** Forget the cached status (a tx was sent, so it no longer describes the window). */
    invalidate(): void {
      cached = undefined;
    },
  };
}

/** Run async tasks one at a time (window opening advances the account's EVM nonce, so it must not overlap a rescue). */
export function createSerial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Diana wiring: REST status read and the hybrid-signed open, both for the guardian (GAS_MNEMONIC) account. */
export function productionWindowDeps(cfg: AgentConfig): Omit<WindowDeps, "log"> {
  return {
    readStatus: () => evmWindowStatus({ rest: NETWORK.rest, address: cfg.gas.evm }),
    open: async () => {
      const msg = openEvmWindowMsg(buildGuardianWindowParams(cfg.gas.cosmos, cfg.vault));
      return (await broadcastTx(cfg.gas, [msg], "qday-guardian: open guardian window")).transactionHash;
    },
  };
}
