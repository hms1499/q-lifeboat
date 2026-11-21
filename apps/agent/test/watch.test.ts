import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { chain } from "@qday/core/chain";
import { createWatchClient } from "../src/rpc";
import { approvalLogToOutbound, DEFAULT_POLL_MS, logToOutbound, txToOutbound, watchOwner } from "../src/watch";

const OWNER = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa" as const;
const TOKEN = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x9999999999999999999999999999999999999999" as const;
const H = "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;
const SPENDER = "0x5555555555555555555555555555555555555555" as const;

type LogsArgs = { event?: { name: string }; fromBlock: bigint; toBlock?: bigint; args?: object };
/** A mock whose getLogs only knows Transfer logs: every Approval read answers []. */
const transfersOnly = (c: { getLogs: (a: LogsArgs) => Promise<unknown[]> }) =>
  ({ ...c, getLogs: async (a: LogsArgs) => (a.event?.name === "Approval" ? [] : c.getLogs(a)) }) as never;

describe("mapping", () => {
  it("maps a Transfer log to an OutboundTx", () => {
    expect(
      logToOutbound({ address: TOKEN, transactionHash: H, blockNumber: 7n, logIndex: 2, args: { from: OWNER, to: OTHER, value: 5n } }),
    ).toEqual({ kind: "transfer", hash: H, block: 7n, token: TOKEN, to: OTHER, amount: 5n });
  });

  it("maps an Approval log to an OutboundTx of kind approval (the spender as `to`)", () => {
    expect(
      approvalLogToOutbound({ address: TOKEN, transactionHash: H, blockNumber: 7n, logIndex: 3, args: { owner: OWNER, spender: SPENDER, value: 9n } }),
    ).toEqual({ kind: "approval", hash: H, block: 7n, token: TOKEN, to: SPENDER, amount: 9n });
  });

  it("maps an owner QOR tx to token 0x0, and ignores zero-value or other senders", () => {
    const base = { hash: H, blockNumber: 8n, from: OWNER, to: OTHER, value: 3n };
    expect(txToOutbound(base, OWNER)).toEqual({
      kind: "transfer", hash: H, block: 8n, token: "0x0000000000000000000000000000000000000000", to: OTHER, amount: 3n,
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t) });
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
      client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5,
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: async () => { throw new Error("boom"); }, onError: (e) => void errors.push(e) });
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block) });
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block) });
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block) });
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t.block), onError: (e) => void errors.push(e) });
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 2, onTx: (t) => void seen.push(t.block) });
    await wait(20);
    tip = 130n;
    await until(() => seen.length >= 120, 2_000);
    await wait(20);
    w.stop();
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => 11n + BigInt(i)));
  });

  it("uses bounded ranges once the known gap plus the re-read blocks exceeds 50 (range-capped node)", async () => {
    let tip = 10n;
    const ranges: { from: bigint; to: bigint; ok: boolean }[] = [];
    const client = {
      getBlockNumber: async () => tip,
      getLogs: async ({ fromBlock, toBlock }: Range) => {
        const to = toBlock ?? tip;
        const ok = to - fromBlock + 1n <= 50n;
        ranges.push({ from: fromBlock, to, ok });
        if (!ok) throw new Error("invalid block range params");
        return logsIn(fromBlock, to);
      },
      getBlock: async () => ({ transactions: [] }),
    };
    const seen: bigint[] = [];
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 2, onTx: (t) => void seen.push(t.block), onError: () => {} });
    await wait(10);
    tip = 20n;
    await until(() => seen.length >= 10, 300); // cursor 20
    tip = 68n; // head - cursor = 48 <= 50, but cursor-2..68 is 51 blocks
    await until(() => seen.length >= 58, 500);
    w.stop();
    expect(seen).toEqual(Array.from({ length: 58 }, (_, i) => 11n + BigInt(i)));
    // Only the tick that discovered the gap may ask for too much; every later range fits.
    expect(ranges.filter((r) => !r.ok).length).toBeLessThanOrEqual(1);
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
      client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: () => {},
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

const approvalAt = (n: bigint, value = 7n) => ({
  address: TOKEN, transactionHash: hashAt(n + 500n), blockNumber: n, logIndex: 1, args: { owner: OWNER, spender: SPENDER, value },
});
/** A mock with one owner Transfer log and one owner Approval log in every block. */
function bothEvents(tipRef: () => bigint, failApproval: () => boolean = () => false) {
  const reads: { event: string; fromBlock: bigint; toBlock?: bigint; args?: object; ok: boolean }[] = [];
  const client = {
    getBlockNumber: async () => tipRef(),
    getLogs: async ({ event, fromBlock, toBlock, args }: LogsArgs) => {
      const failing = event!.name === "Approval" && failApproval();
      reads.push({ event: event!.name, fromBlock, toBlock, args, ok: !failing });
      const to = toBlock ?? tipRef();
      if (event!.name === "Transfer") return logsIn(fromBlock, to);
      if (failing) throw new Error("rpc 502 on approvals");
      const out = [];
      for (let b = fromBlock; b <= to; b++) out.push(approvalAt(b));
      return out;
    },
    getBlock: async () => ({ transactions: [] }),
  };
  return { client: client as never, reads };
}

describe("watchOwner approvals (Task 6B)", () => {
  it("emits owner Approval logs with kind approval and the spender as `to`, filtered on owner", async () => {
    let tip = 10n;
    const { client, reads } = bothEvents(() => tip);
    const seen: { kind: string; to: string; amount: bigint; block: bigint }[] = [];
    const w = watchOwner({ client, owner: OWNER, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t) });
    await wait(20);
    tip = 11n;
    await until(() => seen.length >= 2, 300);
    await wait(20);
    w.stop();
    expect(seen.filter((t) => t.kind === "approval")).toEqual([
      { kind: "approval", hash: hashAt(511n), block: 11n, token: TOKEN, to: SPENDER, amount: 7n },
    ]);
    expect(seen.filter((t) => t.kind === "transfer").map((t) => t.block)).toEqual([11n]);
    expect(reads.find((r) => r.event === "Approval")?.args).toEqual({ owner: OWNER });
  });

  it("a failed Approval read does not advance the cursor: the range is re-read, nothing skipped, transfers still emitted", async () => {
    let tip = 10n;
    let fail = false;
    const { client, reads } = bothEvents(() => tip, () => fail);
    const approvals: bigint[] = [];
    const transfers: bigint[] = [];
    const errors: unknown[] = [];
    const w = watchOwner({
      client, owner: OWNER, tokens: [TOKEN], pollMs: 5, onError: (e) => void errors.push(e),
      onTx: (t) => void (t.kind === "approval" ? approvals : transfers).push(t.block),
    });
    await wait(20);
    fail = true;
    tip = 12n;
    await until(() => transfers.length >= 2, 300); // a drain is a drain: the Transfer read still emits
    await wait(20);
    expect(approvals).toEqual([]);
    tip = 14n;
    await wait(20); // still failing while the tip moves on
    fail = false;
    await until(() => approvals.length >= 4, 300);
    await wait(20);
    w.stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(approvals).toEqual([11n, 12n, 13n, 14n]);
    expect(transfers).toEqual([11n, 12n, 13n, 14n]);
    // The first good Approval read after the failures re-reads from block 11 or earlier (the cursor did not move).
    const approvalReads = reads.filter((r) => r.event === "Approval");
    const firstFail = approvalReads.findIndex((r) => !r.ok);
    expect(firstFail).toBeGreaterThanOrEqual(0);
    const recovery = approvalReads.slice(firstFail).find((r) => r.ok);
    expect(recovery!.fromBlock).toBeLessThanOrEqual(11n);
  });

  it("catch-up (gap > 50) reads both events per range and advances only when both succeeded", async () => {
    let tip = 10n;
    let failures = 2;
    const { client, reads } = bothEvents(() => tip, () => {
      if (failures > 0 && tip === 130n) { failures--; return true; }
      return false;
    });
    const approvals: bigint[] = [];
    const transfers: bigint[] = [];
    const w = watchOwner({
      client, owner: OWNER, tokens: [TOKEN], pollMs: 2, onError: () => {},
      onTx: (t) => void (t.kind === "approval" ? approvals : transfers).push(t.block),
    });
    await wait(20);
    tip = 130n;
    await until(() => approvals.length >= 120 && transfers.length >= 120, 2_000);
    await wait(20);
    w.stop();
    const all = Array.from({ length: 120 }, (_, i) => 11n + BigInt(i));
    expect(approvals).toEqual(all);
    expect(transfers).toEqual(all);
    const bounded = reads.filter((r) => r.toBlock !== undefined);
    expect(bounded.every((r) => r.toBlock! - r.fromBlock + 1n <= 50n)).toBe(true);
    expect(new Set(bounded.map((r) => r.event))).toEqual(new Set(["Transfer", "Approval"]));
  });
});

const hex = (n: bigint) => `0x${n.toString(16)}`;
const transferAbi = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const approvalAbi = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
const APPROVAL_TOPIC = encodeEventTopics({ abi: [approvalAbi], eventName: "Approval" })[0];
/** A raw eth_getLogs entry: owner approves SPENDER for `value` of TOKEN in block `n`. */
const rawApproval = (n: bigint, value: bigint) => ({
  address: TOKEN,
  topics: encodeEventTopics({ abi: [approvalAbi], eventName: "Approval", args: { owner: OWNER.toLowerCase() as `0x${string}`, spender: SPENDER } }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
  blockNumber: hex(n),
  blockHash: hashAt(n + 1000n),
  transactionHash: hashAt(n + 2000n),
  transactionIndex: "0x0",
  logIndex: "0x1",
  removed: false,
});
/** True for an eth_getLogs item that asks for Approval logs. */
const asksApproval = (it: { params?: unknown[] }) => (it.params?.[0] as { topics?: unknown[] })?.topics?.[0] === APPROVAL_TOPIC;
/** A raw eth_getLogs entry: owner -> OTHER Transfer of TOKEN in block `n`. */
const rawTransfer = (n: bigint) => ({
  address: TOKEN,
  topics: encodeEventTopics({ abi: [transferAbi], eventName: "Transfer", args: { from: OWNER.toLowerCase() as `0x${string}`, to: OTHER } }),
  data: encodeAbiParameters([{ type: "uint256" }], [5n]),
  blockNumber: hex(n),
  blockHash: hashAt(n + 1000n),
  transactionHash: hashAt(n),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
});
type RpcItem = { id: number; method: string; params?: unknown[] };
/** A fetch for the watcher's batching client: `answer` replies to each JSON-RPC item; every POST body is kept. */
function rpcFetch(answer: (item: RpcItem, batch: RpcItem[]) => { result?: unknown; error?: { code: number; message: string } }) {
  const posts: RpcItem[][] = [];
  const fetchFn = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const items: RpcItem[] = Array.isArray(body) ? body : [body];
    posts.push(items);
    const replies = items.map((it) => ({ jsonrpc: "2.0", id: it.id, ...answer(it, items) }));
    return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { headers: { "content-type": "application/json" } });
  };
  return { posts, fetchFn: fetchFn as unknown as typeof fetch };
}
const noBlocks = { getBlock: async () => ({ transactions: [] }) };
/** Real viem validates addresses: the mixed-case OWNER fixture is not EIP-55, so use the lowercase form here. */
const OWNER_LC = OWNER.toLowerCase() as `0x${string}`;

describe("watchOwner over the real batching client (Task 5 fix round 5)", () => {
  it("sends exactly ONE POST per tick, carrying eth_blockNumber and the Transfer and Approval eth_getLogs", async () => {
    const { posts, fetchFn } = rpcFetch((it) => (it.method === "eth_blockNumber" ? { result: "0xa" } : { result: [] }));
    const w = watchOwner({ client: createWatchClient(fetchFn), blockClient: noBlocks as never, owner: OWNER_LC, tokens: [TOKEN], pollMs: 5, onTx: () => {} });
    await wait(80);
    w.stop();
    expect(posts.length).toBeGreaterThanOrEqual(4);
    expect(posts[0].map((i) => i.method)).toEqual(["eth_blockNumber"]); // start: the tip only
    for (const p of posts.slice(1)) {
      expect(p.map((i) => i.method).sort()).toEqual(["eth_blockNumber", "eth_getLogs", "eth_getLogs"]);
      expect(p.filter(asksApproval)).toHaveLength(1);
    }
  });

  it("decodes an owner Approval through the real client: kind approval, spender as `to`, owner-filtered topics", async () => {
    let tip = "0xa";
    const { posts, fetchFn } = rpcFetch((it) => {
      if (it.method === "eth_blockNumber") return { result: tip };
      return { result: asksApproval(it) && BigInt((it.params![0] as { fromBlock: string }).fromBlock) <= 11n ? [rawApproval(11n, 2n ** 256n - 1n)] : [] };
    });
    const seen: unknown[] = [];
    const w = watchOwner({ client: createWatchClient(fetchFn), blockClient: noBlocks as never, owner: OWNER_LC, tokens: [TOKEN], pollMs: 5, onTx: (t) => void seen.push(t) });
    await wait(20);
    tip = "0xb";
    await until(() => seen.length >= 1, 300);
    await wait(20);
    w.stop();
    expect(seen).toEqual([{ kind: "approval", hash: hashAt(2011n), block: 11n, token: TOKEN, to: SPENDER, amount: 2n ** 256n - 1n }]);
    const q = posts.flat().find(asksApproval)!.params![0] as { topics: unknown[] };
    expect(q.topics[1]).toBe(`0x${OWNER_LC.slice(2).padStart(64, "0")}`); // indexed owner = the watched account
  });

  it("a per-item eth_getLogs error is not retried on its own (it could reach another node) and does not move the cursor", async () => {
    let phase: "start" | "failing" | "ok" = "start";
    const { posts, fetchFn } = rpcFetch((it, batch) => {
      if (it.method === "eth_blockNumber") return { result: phase === "start" ? "0xa" : "0x14" }; // 10, then 20
      const from = BigInt((it.params![0] as { fromBlock: string }).fromBlock);
      // A lone eth_getLogs is a retry that went to node B, which is behind and has no block 12 yet.
      if (batch.length === 1) return { result: [] };
      if (phase === "failing") return { error: { code: -32603, message: "internal error" } }; // retryable for viem
      if (asksApproval(it)) return { result: [] };
      return { result: from <= 12n ? [rawTransfer(12n)] : [] };
    });
    const seen: bigint[] = [];
    const w = watchOwner({
      client: createWatchClient(fetchFn), blockClient: noBlocks as never, owner: OWNER_LC, tokens: [TOKEN], pollMs: 5,
      onTx: (t) => void seen.push(t.block), onError: () => {},
    });
    await wait(20);
    phase = "failing";
    await wait(400); // longer than viem's retry delay
    phase = "ok";
    await until(() => seen.length >= 1, 300);
    w.stop();
    expect(posts.filter((p) => p.length === 1 && p[0].method === "eth_getLogs")).toEqual([]);
    expect(seen).toEqual([12n]);
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
    const w = watchOwner({ client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], onTx: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(2);
    w.stop();
  });
});

describe("watchOwner onTip (Task 6C /health)", () => {
  afterEach(() => void vi.useRealTimers());

  it("reports the start tip and each advance of the head, never a lower tip, and survives a throwing onTip", async () => {
    vi.useFakeTimers();
    const tips = [10n, 10n, 12n, 11n, 13n];
    let i = 0;
    const client = {
      getBlockNumber: async () => tips[Math.min(i++, tips.length - 1)],
      getLogs: async () => [],
      getBlock: async () => ({ transactions: [] }),
    };
    const seen: bigint[] = [];
    const errors: unknown[] = [];
    const w = watchOwner({
      client: transfersOnly(client), owner: OWNER, tokens: [TOKEN], pollMs: 2,
      onTx: () => {},
      onTip: (b) => { seen.push(b); if (seen.length === 1) throw new Error("tip handler bug"); },
      onError: (e) => void errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(0); // the start tip
    expect(seen).toEqual([10n]);
    for (let t = 0; t < 6; t++) await vi.advanceTimersByTimeAsync(2); // ticks read 10, 12, 11, 13, 13...
    w.stop();
    expect(seen).toEqual([10n, 12n, 13n]);
    expect(errors.some((e) => e instanceof Error && e.message === "tip handler bug")).toBe(true);
  });
});
