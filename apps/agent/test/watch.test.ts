import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom } from "viem";
import { chain } from "@qday/core/chain";
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
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock?: bigint }) =>
        fromBlock <= 11n && 11n <= (toBlock ?? tip) ? [log] : [],
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
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock?: bigint }) => {
        const out = [];
        for (let b = fromBlock; b <= (toBlock ?? tip); b++) out.push(logAt(b, `0x${b}`));
        return out;
      },
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 1_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(2);
}
const hashAt = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const transferAt = (n: bigint) => ({ address: TOKEN, transactionHash: hashAt(n), blockNumber: n, logIndex: 0, args: { from: OWNER, to: OTHER, value: 5n } });
/** One owner Transfer log in every block of [from, to]. */
const logsIn = (from: bigint, to: bigint) => {
  const out = [];
  for (let b = from; b <= to; b++) out.push(transferAt(b));
  return out;
};
type Range = { fromBlock: bigint; toBlock?: bigint };

describe("watchOwner latency and coverage (Task 5 fix round 4)", () => {
  it("a slow native block scan does not delay a Transfer log", async () => {
    let tip = 10n;
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock, toBlock }: Range) => logsIn(fromBlock, toBlock ?? tip),
      getBlock: () => new Promise(() => {}), // the native scan never gets an answer
    };
    const seen: bigint[] = [];
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block) });
    await wait(20);
    tip = 11n;
    await until(() => seen.length >= 1);
    tip = 12n;
    await until(() => seen.length >= 2, 300);
    w.stop();
    expect(seen).toEqual([11n, 12n]);
  });

  it("never skips a block when the getLogs node lags the tip node, and emits each log once", async () => {
    let tip = 10n;
    let logsHead = 10n;
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock, toBlock }: Range) => {
        const to = toBlock ?? logsHead;
        return logsIn(fromBlock, to < logsHead ? to : logsHead);
      },
      getBlock: async () => ({ transactions: [] }),
    };
    const seen: bigint[] = [];
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block) });
    await wait(20);
    tip = 12n; // the tip node has 12, the logs node only 11
    logsHead = 11n;
    await wait(40);
    logsHead = 12n; // the logs node catches up
    await until(() => seen.length >= 2, 300);
    await wait(30);
    w.stop();
    expect(seen).toEqual([11n, 12n]);
  });

  it("covers every block once when getBlockNumber goes backwards, and never replays the history before start", async () => {
    const tips = [10n, 12n, 11n, 11n, 13n];
    let tip = 10n;
    const ranges: Range[] = [];
    const client = {
      getBlockNumber: async () => (tip = tips.length > 1 ? tips.shift()! : tips[0]),
      getLogs: async (r: Range) => {
        ranges.push(r);
        return logsIn(r.fromBlock, r.toBlock ?? tip);
      },
      getBlock: async () => ({ transactions: [] }),
    };
    const seen: bigint[] = [];
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block) });
    await until(() => seen.length >= 3, 300);
    await wait(30);
    w.stop();
    expect(seen).toEqual([11n, 12n, 13n]);
    expect(ranges.every((r) => r.fromBlock >= 11n)).toBe(true);
  });

  it("a failed getLogs does not advance the cursor: the range is retried", async () => {
    let tip = 10n;
    let fail = true;
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock, toBlock }: Range) => {
        if (fail) {
          fail = false;
          throw new Error("rpc 502");
        }
        return logsIn(fromBlock, toBlock ?? tip);
      },
      getBlock: async () => ({ transactions: [] }),
    };
    const seen: bigint[] = [];
    const errors: unknown[] = [];
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block), onError: (e) => void errors.push(e) });
    await wait(20);
    tip = 13n;
    await until(() => seen.length >= 3, 300);
    w.stop();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual([11n, 12n, 13n]);
  });

  it("catches up a long gap in ranges of at most 50 blocks, each log once", async () => {
    let tip = 10n;
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock, toBlock }: Range) => {
        const to = toBlock ?? tip;
        if (to - fromBlock + 1n > 50n) throw new Error("invalid block range params"); // a node with a range cap
        return logsIn(fromBlock, to);
      },
      getBlock: async () => ({ transactions: [] }),
    };
    const seen: bigint[] = [];
    const w = watchOwner({ client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 2, onTx: (t) => void seen.push(t.block) });
    await wait(20);
    tip = 130n;
    await until(() => seen.length >= 120, 2_000);
    await wait(20);
    w.stop();
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => 11n + BigInt(i)));
  });

  it("logs a timing line the first time each item is seen (key, block, tip, wall time), never for a duplicate", async () => {
    let tip = 10n;
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock, toBlock }: Range) => logsIn(fromBlock, toBlock ?? tip),
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        transactions: blockNumber === 11n ? [{ hash: "0xdead", blockNumber: 11n, from: OWNER, to: OTHER, value: 9n }] : [],
      }),
    };
    const lines: string[] = [];
    const w = watchOwner({
      client: client as never, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: () => {},
      log: (l) => void lines.push(l), now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    await wait(20);
    tip = 11n;
    await until(() => lines.length >= 2, 300);
    await wait(30);
    w.stop();
    expect(lines.sort()).toEqual([
      `timing: seen ${hashAt(11n)}:0 block 11 tip 11 at 2026-11-20T00:00:00.000Z`,
      "timing: seen 0xdead:native block 11 tip 11 at 2026-11-20T00:00:00.000Z",
    ]);
  });

  it("reads the tip from the RPC on every tick (bypasses viem's 4 s block-number cache on this chain)", async () => {
    let tipReads = 0;
    const client = createPublicClient({
      chain,
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === "eth_blockNumber") {
            tipReads++;
            return "0xa";
          }
          if (method === "eth_getLogs") return [];
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    expect(client.cacheTime).toBe(4_000); // viem's default here: no blockTime on the chain
    const w = watchOwner({ client, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: () => {} });
    await wait(80);
    w.stop();
    expect(tipReads).toBeGreaterThanOrEqual(5);
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
