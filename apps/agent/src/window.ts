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
export const MIN_BLOCKS = 100n;
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

/** Guardian window length that outlasts an owner window with `ownerRemainingBlocks` left by 200 blocks, capped. */
export function guardianBlocksFor(ownerRemainingBlocks: bigint): number {
  return Math.min(Number(ownerRemainingBlocks) + 200, WINDOW_BLOCKS);
}

/** `MsgOpenEVMWindow` parameters: 14400 blocks, 10 txs, budget for 10 rescue txs, the vault as the only target. */
export function buildGuardianWindowParams(guardianCosmos: string, vault: Hex, blocks: number = WINDOW_BLOCKS) {
  return {
    sender: guardianCosmos,
    blocks,
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
  open(blocks?: number): Promise<string>;
  log(line: string): void;
  sleep?: (ms: number) => Promise<void>;
};

export type WindowKeeper = ReturnType<typeof createWindowKeeper>;

export function createWindowKeeper(deps: WindowDeps) {
  let cached: WindowStatus | undefined;
  /** The last status read, for /health. Unlike `cached`, invalidate() keeps it. */
  let lastRead: WindowStatus | undefined;
  const unusable = (s: WindowStatus, minRemaining?: bigint) =>
    needsWindow(s, deps.vault) || (minRemaining !== undefined && s.remainingBlocks < minRemaining);
  const read = async () => (lastRead = await deps.readStatus());
  let lastOpenHash: string | undefined;

  /**
   * Read the window; if it is not usable, open ONE new window and re-read it (a few times: REST may still serve
   * the block before the open). Throws when it stays unusable. Resolves true when it opened a window: the open
   * is a tx from the guardian account, so a nonce read before it is stale.
   */
  async function ensure(opts?: { blocks?: number; minRemaining?: bigint }): Promise<boolean> {
    cached = await read();
    if (!unusable(cached, opts?.minRemaining)) return false;
    const hash = await deps.open(opts?.blocks);
    lastOpenHash = hash;
    deps.log(`guardian window opened: ${hash}`);
    cached = await pollUntil(read, (s) => !unusable(s, opts?.minRemaining), { tries: STATUS_POLLS, delayMs: POLL_DELAY_MS, sleep: deps.sleep });
    if (unusable(cached, opts?.minRemaining)) throw new Error(`guardian window still not usable after opening (tx ${hash})`);
    return true;
  }

  return {
    ensure,
    /** Read the window status (REST) without opening anything and without needing the guardian's nonce. */
    peek: read,
    /** True when `status` is not usable for a rescue of this vault. */
    needsOpen: (status: WindowStatus): boolean => unusable(status),
    /** Before a rescue: no REST read when the cached status says the window is usable. True when it opened one. */
    async ensureIfStale(): Promise<boolean> {
      if (cached && !unusable(cached)) return false;
      return ensure();
    },
    /** The hash of the last window this keeper opened. */
    lastOpen(): string | undefined {
      return lastOpenHash;
    },
    /** The last window status read (undefined before the first read). No REST call. */
    status(): WindowStatus | undefined {
      return lastRead;
    },
    /** Forget the cached status (a tx was sent, so it no longer describes the window). */
    invalidate(): void {
      cached = undefined;
    },
  };
}

const ARM_ALERT_SUPPRESS_MS = 60_000;
/** After an open throws (e.g. REST lags behind the RPC), wait this long before the watcher tries another one. */
const OPEN_BACKOFF_MS = 60_000;

export type OnDemandDeps = {
  readOwnerWindow(): Promise<Pick<EvmWindow, "live" | "remainingBlocks">>;
  /**
   * `peek` and `needsOpen` run OUTSIDE the guardian's serial queue (a REST read needs no nonce), so a slow read never
   * delays a rescue. `ensure` is the serialised one: it re-reads and opens only if still needed.
   */
  keeper: {
    peek(): Promise<WindowStatus>;
    needsOpen(status: WindowStatus): boolean;
    ensure(opts?: { blocks?: number; minRemaining?: bigint }): Promise<boolean>;
    lastOpen(): string | undefined;
  };
  alert(msg: string): void;
  log(line: string): void;
  now?: () => number;
};

/**
 * Hosted guardians open their window only when needed: `arm` (the owner is about to open theirs) or `tick` (the
 * owner's window is live and the guardian's is not usable). An idle owner costs no tx and no guardian read.
 */
export function createOnDemandWatcher(deps: OnDemandDeps) {
  const now = deps.now ?? Date.now;
  let armedAt = -Infinity;
  let backoffUntil = -Infinity;
  const open = async (opts: { blocks: number; minRemaining?: bigint } | { blocks: number }): Promise<boolean> => {
    try {
      return await deps.keeper.ensure(opts);
    } catch (e) {
      backoffUntil = now() + OPEN_BACKOFF_MS;
      throw e;
    }
  };
  return {
    async tick(): Promise<void> {
      const owner = await deps.readOwnerWindow();
      if (!owner.live || now() < backoffUntil) return;
      if (!deps.keeper.needsOpen(await deps.keeper.peek())) return;
      const opened = await open({ blocks: guardianBlocksFor(owner.remainingBlocks) });
      if (!opened) return;
      deps.log(`owner window live: guardian window opened (${deps.keeper.lastOpen()})`);
      if (now() - armedAt > ARM_ALERT_SUPPRESS_MS) deps.alert("owner window opened outside the app; guardian window opened");
    },
    /**
     * Open a guardian window sized to cover an owner window of `blocks` (blocks + 200, capped). An existing usable
     * window counts only if it has at least blocks + 100 left. Resolves with the open tx hash, or null when none.
     */
    async arm(blocks: number): Promise<string | null> {
      armedAt = now(); // before any wait: a tick queued behind this must not raise a false alert
      const openBlocks = guardianBlocksFor(BigInt(blocks));
      const need = BigInt(blocks) + MIN_BLOCKS;
      const cap = BigInt(openBlocks) - MIN_BLOCKS;
      const opened = await open({ blocks: openBlocks, minRemaining: need < cap ? need : cap });
      armedAt = now();
      return opened ? (deps.keeper.lastOpen() ?? null) : null;
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
    open: async (blocks) => {
      const before = await evmNonce();
      const msg = openEvmWindowMsg(buildGuardianWindowParams(cfg.gas.cosmos, cfg.vault, blocks));
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
