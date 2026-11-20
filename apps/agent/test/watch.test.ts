import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLL_MS, logToOutbound, txToOutbound, watchOwner } from "../src/watch";

const OWNER = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa" as const;
const TOKEN = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x9999999999999999999999999999999999999999" as const;
const H = "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;

describe("mapping", () => {
  it("maps a Transfer log to an OutboundTx", () => {
    expect(
      logToOutbound({ address: TOKEN, transactionHash: H, blockNumber: 7n, logIndex: 2, args: { from: OWNER, to: OTHER, value: 5n } }),
    ).toEqual({ hash: H, block: 7n, token: TOKEN, to: OTHER, amount: 5n });
  });

  it("maps an owner QOR tx to token 0x0, and ignores zero-value or other senders", () => {
    const base = { hash: H, blockNumber: 8n, from: OWNER, to: OTHER, value: 3n };
    expect(txToOutbound(base, OWNER)).toEqual({
      hash: H, block: 8n, token: "0x0000000000000000000000000000000000000000", to: OTHER, amount: 3n,
    });
    expect(txToOutbound({ ...base, value: 0n }, OWNER)).toBeNull();
    expect(txToOutbound({ ...base, from: OTHER }, OWNER)).toBeNull();
    expect(txToOutbound({ ...base, to: null }, OWNER)).toBeNull();
    expect(txToOutbound({ ...base, from: OWNER.toLowerCase() as `0x${string}` }, OWNER)).not.toBeNull();
  });
});

describe("watchOwner polling", () => {
  it("emits each outbound item once across overlapping polls and ignores the history before start", async () => {
    let tip = 10n;
    const log = { address: TOKEN, transactionHash: H, blockNumber: 11n, logIndex: 0, args: { from: OWNER, to: OTHER, value: 5n } };
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
        fromBlock <= 11n && 11n <= toBlock ? [log] : [],
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        transactions: blockNumber === 11n ? [{ hash: "0xdead", blockNumber: 11n, from: OWNER, to: OTHER, value: 9n }] : [],
      }),
    };
    const seen: unknown[] = [];
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t) });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(0); // nothing new yet
    tip = 11n;
    await new Promise((r) => setTimeout(r, 60));
    w.stop();
    expect(seen).toHaveLength(2); // one ERC-20 log + one QOR tx, no duplicates
  });

  it("does not wait for a slow onTx: polling keeps going", async () => {
    let tip = 10n;
    const logAt = (n: bigint, h: string) => ({ address: TOKEN, transactionHash: h, blockNumber: n, logIndex: 0, args: { from: OWNER, to: OTHER, value: 5n } });
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) => [logAt(fromBlock, `0x${fromBlock}`)],
      getBlock: async () => ({ transactions: [] }),
    };
    const seen: bigint[] = [];
    const w = watchOwner({
      client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5,
      onTx: (t) => { seen.push(t.block); return new Promise<void>(() => {}); }, // never resolves
    });
    await new Promise((r) => setTimeout(r, 20));
    tip = 11n;
    await new Promise((r) => setTimeout(r, 30));
    tip = 12n;
    await new Promise((r) => setTimeout(r, 30));
    w.stop();
    expect(seen).toEqual([11n, 12n]);
  });

  it("routes a rejecting onTx to onError instead of stalling", async () => {
    let tip = 10n;
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async () => [{ address: TOKEN, transactionHash: H, blockNumber: 11n, logIndex: 0, args: { from: OWNER, to: OTHER, value: 5n } }],
      getBlock: async () => ({ transactions: [] }),
    };
    const errors: unknown[] = [];
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: async () => { throw new Error("boom"); }, onError: (e) => void errors.push(e) });
    await new Promise((r) => setTimeout(r, 15));
    tip = 11n;
    await new Promise((r) => setTimeout(r, 30));
    w.stop();
    expect(errors).toHaveLength(1);
  });
});

describe("watchOwner pacing", () => {
  afterEach(() => void vi.useRealTimers());

  it("polls every 300 ms by default (diana blocks are ~1.4 s, so a drain is seen within ~0.3 s)", async () => {
    expect(DEFAULT_POLL_MS).toBe(300);
    vi.useFakeTimers();
    let polls = 0;
    const client = {
      getBlockNumber: async () => { polls++; return 10n; },
      getLogs: async () => [],
      getBlock: async () => ({ transactions: [] }),
    };
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], onTx: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(2);
    w.stop();
  });
});
