import type { Hex } from "viem";
import type { AlertEvent } from "./notify";
import { needsWindow, type WindowStatus } from "./window";

/** Alert when the guardian holds less than 0.5 QOR (GAS_LOW_WEI): it pays every rescue tx and window open. */
export const DEFAULT_GAS_LOW_WEI = 500_000_000_000_000_000n;
/** /health is not ok when the watcher has seen no new block for this long (diana makes one every ~1.4 s). */
const TIP_STALE_MS = 30_000;

export type HealthOptions = {
  guardian: Hex;
  /** The vault the guardian window must target (window.ts `needsWindow`). */
  vault: Hex;
  gasLowWei: bigint;
  readBalance: () => Promise<bigint>;
  /** The window keeper's last status read (no REST call). */
  readWindow: () => WindowStatus | undefined;
  channels: { telegram: boolean; webhook: boolean };
  notify: (e: AlertEvent) => void | Promise<unknown>;
  log: (line: string) => void;
  now?: () => Date;
  startedAt?: string;
};

export type HealthSnapshot = {
  ok: boolean;
  startedAt: string;
  lastBlock: bigint | null;
  lastBlockAt: string | null;
  window: { live: boolean; remainingBlocks: bigint; remainingTxs: bigint; remainingValue: bigint } | null;
  gas: { guardian: Hex; balance: bigint | null; threshold: bigint; low: boolean };
  alerts: { telegram: boolean; webhook: boolean };
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Cached liveness for GET /health: the watcher's tip, the guardian window and the guardian's gas balance. A snapshot
 * never makes an RPC/REST call; `checkGas` (run on a timer) is the only reader. Nothing here is on the rescue path.
 */
export function createHealth(opts: HealthOptions) {
  const now = opts.now ?? (() => new Date());
  const startedAt = opts.startedAt ?? now().toISOString();
  let lastBlock: bigint | null = null;
  let lastBlockAt: Date | null = null;
  let balance: bigint | null = null;
  let alerted = false;

  return {
    setTip(block: bigint): void {
      lastBlock = block;
      lastBlockAt = now();
    },

    /** Read and cache the guardian balance; one `gas-low` alert per drop below the threshold. Never throws. */
    async checkGas(): Promise<void> {
      try {
        balance = await opts.readBalance();
      } catch (e) {
        opts.log(`gas check error: ${errorText(e)}`);
        return;
      }
      if (balance >= opts.gasLowWei) {
        alerted = false;
        return;
      }
      if (alerted) return;
      alerted = true;
      opts.log(`guardian gas low: ${balance} wei < ${opts.gasLowWei} wei`);
      try {
        void Promise.resolve(opts.notify({ type: "gas-low", guardian: opts.guardian, balance, threshold: opts.gasLowWei })).catch((e) =>
          opts.log(`notify error: ${errorText(e)}`),
        );
      } catch (e) {
        opts.log(`notify error: ${errorText(e)}`);
      }
    },

    snapshot(): HealthSnapshot {
      const w = opts.readWindow();
      const window = w ? { live: w.live, remainingBlocks: w.remainingBlocks, remainingTxs: w.remainingTxs, remainingValue: w.remainingValue } : null;
      const low = balance !== null && balance < opts.gasLowWei;
      const tipFresh = lastBlockAt !== null && now().getTime() - lastBlockAt.getTime() <= TIP_STALE_MS;
      return {
        // Usable as the rescue path sees it: live, scoped to this vault, enough blocks, txs and value left.
        ok: tipFresh && !!w && !needsWindow(w, opts.vault) && balance !== null && !low,
        startedAt,
        lastBlock,
        lastBlockAt: lastBlockAt ? lastBlockAt.toISOString() : null,
        window,
        gas: { guardian: opts.guardian, balance, threshold: opts.gasLowWei, low },
        alerts: { ...opts.channels },
      };
    },
  };
}
