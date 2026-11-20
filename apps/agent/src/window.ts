import { broadcastTx, publicClient } from "@qday/core/chain";
import { NETWORK } from "@qday/core";
import { evmWindowCost, evmWindowStatus, type EvmWindow } from "@qorechain/evm";
import { openEvmWindowMsg } from "@qorechain/sdk";
import type { Hex } from "viem";
import type { AgentConfig } from "./config";
import { RESCUE_GAS, RESCUE_MAX_FEE_PER_GAS } from "./rescue";

/**
 * The guardian account's own EVM window. The agent sends `vault.rescue` as plain EVM txs, which the chain
 * admits only inside a window opened by a hybrid-signed (ECDSA + ML-DSA-87) native-lane message. The window
 * is scoped to the vault alone, so a leaked guardian ECDSA key can only call the vault.
 */
/**
 * ~5.7 h at diana's ~1.42 s blocks, so the guardian reopens a few times a day, not every few minutes (each open is
 * a 0.225 QOR hybrid tx). A long window costs no security: it only reaches the vault and its budget is tiny.
 */
const WINDOW_BLOCKS = 14_400;
const WINDOW_MAX_TXS = 10;
const MIN_BLOCKS = 100n;
const MIN_TXS = 3n;
/** What one rescue tx can take from the window, in uqor (at the fee cap every rescue tx is sent with). */
const RESCUE_TX_COST = evmWindowCost({ gas: RESCUE_GAS, maxFeePerGas: RESCUE_MAX_FEE_PER_GAS });
/** Status reads after an open before giving up: REST may lag the RPC node that confirmed the open. */
export const STATUS_POLLS = 4;
const POLL_DELAY_MS = 1_500;
const REST_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 90_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Read until `ok(value)` or `tries` reads were made; returns the last value read. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  opts: { tries: number; delayMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const wait = opts.sleep ?? sleep;
  let v = await read();
  for (let i = 1; i < opts.tries && !ok(v); i++) {
    await wait(opts.delayMs);
    v = await read();
  }
  return v;
}

/** Wrap a periodic task so a tick is dropped while the previous run is still going (no pile-up in the queue). */
export function skipWhileBusy(task: () => Promise<void>): () => Promise<void> {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } finally {
      busy = false;
    }
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export type WindowStatus = Pick<EvmWindow, "live" | "remainingBlocks" | "remainingTxs" | "remainingValue" | "allowedTargets">;

/**
 * True when the window cannot be relied on for a 3-token rescue of `vault`: not live, low on blocks, txs or
 * value, or not scoped to this vault (a window left from another vault, e.g. the previous fresh demo run, or an
 * unscoped one: the guardian's window must name the vault so its ECDSA key can reach nothing else).
 */
export function needsWindow(s: WindowStatus, vault: Hex): boolean {
  const targetsVault = s.allowedTargets.some((t) => t.toLowerCase() === vault.toLowerCase());
  return (
    !s.live ||
    !targetsVault ||
    s.remainingBlocks < MIN_BLOCKS ||
    s.remainingTxs < MIN_TXS ||
    s.remainingValue < RESCUE_TX_COST * MIN_TXS
  );
}

/** `MsgOpenEVMWindow` parameters: 14400 blocks, 10 txs, budget for 10 rescue txs, the vault as the only target. */
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
  /** The vault the window must target. */
  vault: Hex;
  readStatus(): Promise<WindowStatus>;
  /** Broadcast `MsgOpenEVMWindow` (replaces an unexpired window); resolves with the tx hash once delivered. */
  open(): Promise<string>;
  log(line: string): void;
  sleep?: (ms: number) => Promise<void>;
};

export type WindowKeeper = ReturnType<typeof createWindowKeeper>;

export function createWindowKeeper(deps: WindowDeps) {
  let cached: WindowStatus | undefined;
  const unusable = (s: WindowStatus) => needsWindow(s, deps.vault);

  /**
   * Read the window; if it is not usable, open ONE new window and re-read it (a few times: REST may still serve
   * the block before the open). Throws when it stays unusable.
   */
  async function ensure(): Promise<void> {
    cached = await deps.readStatus();
    if (!unusable(cached)) return;
    const hash = await deps.open();
    deps.log(`guardian window opened: ${hash}`);
    cached = await pollUntil(deps.readStatus, (s) => !unusable(s), { tries: STATUS_POLLS, delayMs: POLL_DELAY_MS, sleep: deps.sleep });
    if (unusable(cached)) throw new Error(`guardian window still not usable after opening (tx ${hash})`);
  }

  return {
    ensure,
    /** Before a rescue: no REST read when the cached status says the window is usable. */
    async ensureIfStale(): Promise<void> {
      if (cached && !unusable(cached)) return;
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

/**
 * Diana wiring: REST status read (5 s timeout) and the hybrid-signed open (90 s timeout), both for the guardian
 * (GAS_MNEMONIC) account. The open timeout keeps a hung REST/RPC call from blocking rescues behind it forever;
 * if a timed-out open lands later, the next rescue may clash on the nonce and fail (logged, retried on the next
 * trigger), which is the lesser risk. The open advances the account's EVM nonce, so it returns only once the EVM RPC (which
 * the rescue reads its nonce from) has seen that, or after ~10 s, whichever is first.
 */
export function productionWindowDeps(cfg: AgentConfig, log: (line: string) => void): WindowDeps {
  const evmNonce = () => publicClient.getTransactionCount({ address: cfg.gas.evm as Hex, blockTag: "pending" });
  return {
    vault: cfg.vault,
    readStatus: () =>
      evmWindowStatus({
        rest: NETWORK.rest,
        address: cfg.gas.evm,
        fetch: (url) => fetch(url, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) }),
      }),
    open: async () => {
      const before = await evmNonce();
      const msg = openEvmWindowMsg(buildGuardianWindowParams(cfg.gas.cosmos, cfg.vault));
      const { transactionHash } = await withTimeout(
        broadcastTx(cfg.gas, [msg], "qday-guardian: open guardian window"),
        OPEN_TIMEOUT_MS,
        "opening the guardian window",
      );
      const after = await pollUntil(evmNonce, (n) => n > before, { tries: 10, delayMs: 1_000 });
      if (after <= before) log(`warning: EVM nonce still ${after} ~10 s after window open ${transactionHash}; a rescue may hit "nonce too low"`);
      return transactionHash;
    },
    log,
  };
}
