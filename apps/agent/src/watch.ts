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
  client: WatchClient;
  owner: Hex;
  tokens: Hex[];
  onTx: (tx: OutboundTx) => void | Promise<void>;
  pollMs?: number;
  onError?: (e: unknown) => void;
};

const MAX_RANGE = 50n;

/**
 * Poll for new blocks and emit every outbound transfer from the owner: ERC-20 `Transfer(from=owner)` on
 * the given tokens plus native QOR txs. Starts at the current tip (history is not replayed). A failed
 * poll does not advance the cursor, so the range is retried. Items are deduplicated by hash + log index.
 */
export function watchOwner(opts: WatchOptions): { stop(): void } {
  const { client, owner, tokens, onTx, pollMs = 1000, onError = () => {} } = opts;
  let stopped = false;
  let cursor: bigint | undefined;
  const seen = new Set<string>();

  const emit = async (key: string, tx: OutboundTx) => {
    if (seen.has(key)) return;
    seen.add(key);
    await onTx(tx);
  };

  const poll = async () => {
    const tip = await client.getBlockNumber();
    let cur: bigint = cursor ?? tip;
    cursor = cur;
    while (cur < tip && !stopped) {
      const from: bigint = cur + 1n;
      const to: bigint = tip - cur > MAX_RANGE ? cur + MAX_RANGE : tip;
      const logs = await client.getLogs({ address: tokens, event: transferEvent, args: { from: owner }, fromBlock: from, toBlock: to });
      for (const l of logs) await emit(`${l.transactionHash}:${l.logIndex}`, logToOutbound(l as unknown as TransferLog));
      for (let b = from; b <= to; b++) {
        const block = await client.getBlock({ blockNumber: b, includeTransactions: true });
        for (const t of block.transactions) {
          const o = txToOutbound(t as BlockTx, owner);
          if (o) await emit(`${o.hash}:native`, o);
        }
      }
      cur = to;
      cursor = to;
    }
  };

  void (async () => {
    while (!stopped) {
      try {
        await poll();
      } catch (e) {
        onError(e);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  })();

  return { stop: () => void (stopped = true) };
}
