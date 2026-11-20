import { parseAbiItem, type Hex, type PublicClient } from "viem";
import type { OutboundTx } from "@qday/core";

const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

type TransferLog = {
  address: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  args: { from?: Hex; to?: Hex; value?: bigint };
};

export function logToOutbound(log: TransferLog): OutboundTx {
  return { hash: log.transactionHash, block: log.blockNumber, token: log.address, to: log.args.to!, amount: log.args.value! };
}

type BlockTx = { hash: Hex; blockNumber: bigint | null; from: Hex; to: Hex | null; value: bigint };

/** A native QOR transfer sent by `owner`, or null (other senders, contract creations, zero value). */
export function txToOutbound(tx: BlockTx, owner: Hex): OutboundTx | null {
  if (tx.from.toLowerCase() !== owner.toLowerCase() || !tx.to || tx.value <= 0n) return null;
  return { hash: tx.hash, block: tx.blockNumber ?? 0n, token: ZERO, to: tx.to, amount: tx.value };
}

export type WatchClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;

export type WatchOptions = {
  /** Tip + Transfer-log reads. Pass a batching client (rpc.ts) so each tick is one HTTP request. */
  client: WatchClient;
  /** Native-QOR block reads (default `client`). A separate client keeps a slow block off the log path's batch. */
  blockClient?: Pick<PublicClient, "getBlock">;
  owner: Hex;
  tokens: Hex[];
  onTx: (tx: OutboundTx) => void | Promise<void>;
  pollMs?: number;
  onError?: (e: unknown) => void;
  /** `timing:` lines (first sight of each item) for latency tuning. Optional. */
  log?: (line: string) => void;
  now?: () => Date;
};

/** Largest getLogs range when catching up a gap of known size. */
const MAX_RANGE = 50n;
/**
 * Every log query re-reads the last REQUERY_BLOCKS blocks already covered (from = cursor - 2), so a log the node
 * did not have yet (a load-balanced node a block or two behind, or a block committed between the tip read and the
 * log read) is still found. The hash:logIndex dedupe drops the repeats.
 */
const REQUERY_BLOCKS = 3n;
/**
 * Diana makes a block every ~1.4 s. Polling at 300 ms sees a drain within ~0.3 s of its block, so the rescue
 * can land in the next block or two (Task 5: rescue <= 3 blocks after the first drain). Override with POLL_MS.
 */
export const DEFAULT_POLL_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Emit every outbound transfer from the owner: ERC-20 `Transfer(from=owner)` on the given tokens plus native QOR
 * txs. Starts at the current tip (history is not replayed). Two independent loops, so a slow block read never
 * delays a token drain:
 * - logs: each tick reads the tip and the Transfer logs from `cursor - 2` to latest TOGETHER (one batched request,
 *   one round trip). The tip is always read from the RPC (`cacheTime: 0`; viem would otherwise cache it for 4 s
 *   on this chain). A gap of more than MAX_RANGE blocks (the agent stalled) is caught up in MAX_RANGE ranges.
 * - native: scans each block up to the highest tip the log loop has seen, one getBlock per block.
 * A failed read never advances a cursor, so nothing is skipped. Items are deduplicated by hash + log index.
 */
export function watchOwner(opts: WatchOptions): { stop(): void } {
  const { client, owner, tokens, onTx, pollMs = DEFAULT_POLL_MS, onError = () => {}, log = () => {}, now = () => new Date() } = opts;
  const blockClient = opts.blockClient ?? client;
  let stopped = false;
  /** The tip at start: blocks up to it are history and never read. */
  let start: bigint | undefined;
  /** Log loop: every block in (start, cursor] was inside a successful getLogs range. */
  let cursor = 0n;
  /** Highest tip read so far. */
  let head = 0n;
  /** Native loop: every block in (start, nativeCursor] was scanned. */
  let nativeCursor = 0n;
  const seen = new Set<string>();

  // Fire and forget: a slow pipeline (rescue + LLM) must never stall polling, or the guardian's
  // single-flight guard could never see a second trigger. Failures go to onError.
  const emit = (key: string, tx: OutboundTx) => {
    if (seen.has(key)) return;
    seen.add(key);
    log(`timing: seen ${key} block ${tx.block} tip ${head} at ${now().toISOString()}`);
    void Promise.resolve()
      .then(() => onTx(tx))
      .catch(onError);
  };
  const emitLogs = (logs: unknown[]) => {
    for (const l of logs as TransferLog[]) emit(`${l.transactionHash}:${l.logIndex}`, logToOutbound(l));
  };
  const getLogs = (fromBlock: bigint, toBlock?: bigint) =>
    client.getLogs({ address: tokens, event: transferEvent, args: { from: owner }, fromBlock, ...(toBlock === undefined ? {} : { toBlock }) });

  const logTick = async () => {
    if (start === undefined) {
      start = cursor = head = nativeCursor = await client.getBlockNumber({ cacheTime: 0 });
      return;
    }
    const lowest = start + 1n;
    const back = cursor - (REQUERY_BLOCKS - 1n);
    const from = back > lowest ? back : lowest;
    if (head - cursor > MAX_RANGE) {
      const to = from + MAX_RANGE - 1n;
      emitLogs(await getLogs(from, to));
      cursor = to;
      return;
    }
    // Issued in the same turn: a batching client sends both in one request, so one node answers both.
    const [tip, logs] = await Promise.allSettled([client.getBlockNumber({ cacheTime: 0 }), getLogs(from)]);
    if (tip.status === "fulfilled" && tip.value > head) head = tip.value;
    if (logs.status === "fulfilled") emitLogs(logs.value); // even without a tip: a drain is a drain
    // Either failed: the cursor stays (a too-large range is then caught up in MAX_RANGE parts, as head moved).
    if (tip.status === "rejected") throw tip.reason;
    if (logs.status === "rejected") throw logs.reason;
    // A stale node's lower tip never moves the cursor back; its logs were still emitted (deduped).
    if (tip.value > cursor) cursor = tip.value;
  };

  const nativeTick = async () => {
    while (start !== undefined && nativeCursor < head && !stopped) {
      const b = nativeCursor + 1n;
      const block = await blockClient.getBlock({ blockNumber: b, includeTransactions: true });
      for (const t of block.transactions) {
        const o = txToOutbound(t as BlockTx, owner);
        if (o) emit(`${o.hash}:native`, o);
      }
      nativeCursor = b;
    }
  };

  const loop = async (tick: () => Promise<void>) => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        onError(e);
      }
      await sleep(pollMs);
    }
  };
  void loop(logTick);
  void loop(nativeTick);

  return { stop: () => void (stopped = true) };
}
