import { describe, expect, it, vi } from "vitest";
import { RESCUE_SELECTOR, vaultAbi } from "@qday/core";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import type { AgentConfig } from "../src/config";
import {
  productionDeps,
  RESCUE_GAS,
  RESCUE_MAX_FEE_PER_GAS,
  RESCUE_PRIORITY_FEE_PER_GAS,
  rescueAll,
  type RescueDeps,
  type RescueReceipt,
  type RescueTx,
} from "../src/rescue";
import { createBatchClient } from "../src/rpc";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const C = "0x00000000000000000000000000000000000000c3" as const;

/** A `Rescued(token, amount)` log as it appears in a receipt. */
function rescuedLog(token: Hex, amount: bigint, address: Hex = VAULT) {
  return {
    address,
    topics: encodeEventTopics({ abi: vaultAbi, eventName: "Rescued", args: { token } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  } as RescueReceipt["logs"][number];
}

const hashOf = (nonce: number) => `0x${nonce.toString(16).padStart(64, "0")}` as Hex;

function makeDeps(over: {
  balances?: Record<string, bigint>;
  allowances?: Record<string, bigint>;
  /** Receipt per token; default: success with an honest Rescued log of min(balance, allowance). */
  receipts?: Record<string, RescueReceipt | Error>;
  sendThrows?: Record<string, Error>;
  /** Tokens whose send throws although the node took the tx (the response was lost). */
  takenDespiteError?: string[];
  readThrows?: Record<string, Error>;
  nonceThrows?: Error;
  /** Successive fetchNonce results (default: always 41). */
  nonces?: number[];
} = {}) {
  const balances = over.balances ?? { [A]: 10n, [B]: 20n, [C]: 30n };
  const allowances = over.allowances ?? { [A]: 10n ** 30n, [B]: 10n ** 30n, [C]: 10n ** 30n };
  const tokenByHash = new Map<Hex, Hex>();
  const txByRaw = new Map<Hex, RescueTx>();
  const order: string[] = [];
  const prepare = vi.fn(async (): Promise<boolean> => { order.push("prepare"); return false; });
  const nonces = [...(over.nonces ?? [])];
  const fetchNonce = vi.fn(async () => {
    order.push("nonce");
    if (over.nonceThrows) throw over.nonceThrows;
    return nonces.shift() ?? 41;
  });
  const tokenOf = (tx: RescueTx) => (decodeFunctionData({ abi: vaultAbi, data: tx.data }).args as readonly Hex[])[0].toLowerCase() as Hex;
  const signTx = vi.fn(async (tx: RescueTx) => {
    const raw = `0x${tx.nonce.toString(16)}${tx.data.slice(2)}` as Hex;
    txByRaw.set(raw, tx);
    return { hash: hashOf(tx.nonce), raw };
  });
  const sendRaw = vi.fn(async (raw: Hex) => {
    const tx = txByRaw.get(raw)!;
    const token = tokenOf(tx);
    order.push(`send:${token}`);
    if (over.takenDespiteError?.includes(token)) {
      tokenByHash.set(hashOf(tx.nonce), token);
      throw new Error("socket hang up");
    }
    const err = over.sendThrows?.[token];
    if (err) throw err;
    tokenByHash.set(hashOf(tx.nonce), token);
  });
  const isKnown = vi.fn(async (hash: Hex) => tokenByHash.has(hash));
  const waitReceipt = vi.fn(async (hash: Hex): Promise<RescueReceipt> => {
    order.push("wait");
    const token = tokenByHash.get(hash)!;
    const r = over.receipts?.[token];
    if (r instanceof Error) throw r;
    if (r) return r;
    const b = balances[token] ?? 0n, a = allowances[token] ?? 0n;
    return { status: "success", logs: [rescuedLog(token, b < a ? b : a)] };
  });
  const deps: RescueDeps = {
    vault: VAULT,
    tokens: [A, B, C],
    readBalance: async (t) => {
      const err = over.readThrows?.[t];
      if (err) throw err;
      return balances[t] ?? 0n;
    },
    readAllowance: async (t) => allowances[t] ?? 0n,
    prepare,
    fetchNonce,
    signTx,
    sendRaw,
    isKnown,
    waitReceipt,
  };
  return { deps, prepare, fetchNonce, signTx, sendRaw, isKnown, waitReceipt, order };
}

describe("rescueAll", () => {
  it("test_skipsTokensWithZeroOwnerBalance (RF1: the nonce read runs alongside, but nothing is prepared or sent)", async () => {
    const { deps, prepare, signTx, sendRaw } = makeDeps({ balances: {} });
    expect(await rescueAll(deps)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(signTx).not.toHaveBeenCalled();
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("RF1: nothing to rescue and a failing nonce read still returns [] (no error, no unhandled rejection)", async () => {
    const { deps, prepare, signTx, sendRaw } = makeDeps({ balances: {}, nonceThrows: new Error("no rpc") });
    expect(await rescueAll(deps)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(signTx).not.toHaveBeenCalled();
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("starts the nonce read together with every balance/allowance read, before any of them resolves (one RTT)", async () => {
    const pending: { resolve: (v: bigint) => void }[] = [];
    const deferred = () => new Promise<bigint>((resolve) => void pending.push({ resolve }));
    const { deps, fetchNonce, sendRaw } = makeDeps();
    const readBalance = vi.fn(deferred);
    const readAllowance = vi.fn(deferred);
    deps.readBalance = readBalance;
    deps.readAllowance = readAllowance;
    const run = rescueAll(deps, B);
    // All issued in the same synchronous turn, so a batching transport sends them as ONE request.
    expect(readBalance).toHaveBeenCalledTimes(3);
    expect(readAllowance).toHaveBeenCalledTimes(3);
    expect(fetchNonce).toHaveBeenCalledTimes(1);
    for (const p of pending) p.resolve(5n);
    const res = await run;
    expect(fetchNonce).toHaveBeenCalledTimes(1);
    expect(sendRaw).toHaveBeenCalledTimes(3);
    expect(res.map((r) => [r.token, r.success])).toEqual([[B, true], [A, true], [C, true]]);
  });

  it("re-reads the nonce when prepare() opened a window (the open used the guardian's nonce)", async () => {
    const { deps, prepare, fetchNonce, signTx, order } = makeDeps({ balances: { [A]: 1n, [B]: 2n }, nonces: [41, 42] });
    prepare.mockImplementationOnce(async () => { order.push("prepare"); return true; });
    await rescueAll(deps);
    expect(fetchNonce).toHaveBeenCalledTimes(2);
    expect(order.slice(0, 3)).toEqual(["nonce", "prepare", "nonce"]);
    expect(signTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([42, 43]);
  });

  it("test_skipsTokenWithZeroAllowance", async () => {
    const { deps, signTx } = makeDeps({ allowances: { [A]: 0n, [B]: 10n ** 30n, [C]: 10n ** 30n } });
    const res = await rescueAll(deps);
    expect(res.map((r) => r.token)).toEqual([B, C]);
    expect(signTx).toHaveBeenCalledTimes(2);
  });

  it("sends one tx per token with sequential nonces, all before waiting for receipts", async () => {
    const { deps, signTx, fetchNonce, order } = makeDeps({ allowances: { [A]: 7n, [B]: 10n ** 30n, [C]: 10n ** 30n } });
    const res = await rescueAll(deps);
    expect(fetchNonce).toHaveBeenCalledTimes(1);
    expect(signTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42, 43]);
    expect(order).toEqual(["nonce", "prepare", `send:${A}`, `send:${B}`, `send:${C}`, "wait", "wait", "wait"]);
    expect(res).toEqual([
      { token: A, hash: hashOf(41), amount: 7n, expected: 7n, success: true },
      { token: B, hash: hashOf(42), amount: 20n, expected: 20n, success: true },
      { token: C, hash: hashOf(43), amount: 30n, expected: 30n, success: true },
    ]);
  });

  it("locks the calldata: to = vault, rescue(token), no value, tight gas, the fee cap the window is sized for", async () => {
    const { deps, signTx } = makeDeps({ balances: { [A]: 1n, [B]: 2n } });
    await rescueAll(deps);
    expect(RESCUE_GAS).toBe(120_000n);
    expect(RESCUE_MAX_FEE_PER_GAS).toBe(150_000_000_000n);
    expect(RESCUE_PRIORITY_FEE_PER_GAS).toBe(40_000_000_000n);
    for (const [[tx], token] of signTx.mock.calls.map((c, i) => [c, [A, B][i]] as const)) {
      expect(Object.keys(tx).sort()).toEqual(["data", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "to"]);
      expect(tx.maxFeePerGas).toBe(RESCUE_MAX_FEE_PER_GAS);
      expect(tx.maxPriorityFeePerGas).toBe(RESCUE_PRIORITY_FEE_PER_GAS);
      expect(tx.to).toBe(VAULT);
      expect(tx.gas).toBe(RESCUE_GAS);
      expect(tx.data.slice(0, 10)).toBe(RESCUE_SELECTOR);
      const d = decodeFunctionData({ abi: vaultAbi, data: tx.data });
      expect(d.functionName).toBe("rescue");
      expect((d.args as readonly string[]).map((x) => x.toLowerCase())).toEqual([token]);
    }
  });

  it("tips 40 gwei to outbid a default-fee attacker, and the 150 gwei cap still covers diana's 100 gwei base fee", () => {
    const DIANA_BASE_FEE = 100_000_000_000n;
    expect(RESCUE_PRIORITY_FEE_PER_GAS).toBe(40_000_000_000n);
    expect(DIANA_BASE_FEE + RESCUE_PRIORITY_FEE_PER_GAS).toBeLessThanOrEqual(RESCUE_MAX_FEE_PER_GAS);
  });

  it("plans the trigger's token first (first nonce, first send), then the others in config order", async () => {
    const { deps, signTx, order } = makeDeps();
    const res = await rescueAll(deps, B);
    expect(order).toEqual(["nonce", "prepare", `send:${B}`, `send:${A}`, `send:${C}`, "wait", "wait", "wait"]);
    expect(signTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42, 43]);
    expect(res).toEqual([
      { token: B, hash: hashOf(41), amount: 20n, expected: 20n, success: true },
      { token: A, hash: hashOf(42), amount: 10n, expected: 10n, success: true },
      { token: C, hash: hashOf(43), amount: 30n, expected: 30n, success: true },
    ]);
  });

  it("matches the trigger token case-insensitively; a trigger outside the vault tokens (native QOR) keeps config order", async () => {
    const upper = makeDeps();
    await rescueAll(upper.deps, "0x00000000000000000000000000000000000000C3");
    expect(upper.order.filter((o) => o.startsWith("send:"))).toEqual([`send:${C}`, `send:${A}`, `send:${B}`]);

    const native = makeDeps();
    await rescueAll(native.deps, "0x0000000000000000000000000000000000000000");
    expect(native.order.filter((o) => o.startsWith("send:"))).toEqual([`send:${A}`, `send:${B}`, `send:${C}`]);
  });

  it("logs when each rescue tx was sent and the block its receipt landed in (latency tuning)", async () => {
    const lines: string[] = [];
    const { deps } = makeDeps({
      balances: { [A]: 1n },
      receipts: { [A]: { status: "success", blockNumber: 77n, logs: [rescuedLog(A, 1n)] } },
    });
    deps.log = (l) => void lines.push(l);
    deps.now = () => new Date("2026-11-20T00:00:00.000Z");
    await rescueAll(deps, A);
    expect(lines).toEqual([
      `timing: rescue ${A} sent ${hashOf(41)} at 2026-11-20T00:00:00.000Z`,
      `timing: rescue ${hashOf(41)} receipt block 77 status success`,
    ]);
  });

  it("reports a reverted receipt as failed with amount 0", async () => {
    const { deps } = makeDeps({
      balances: { [A]: 1n, [B]: 2n },
      receipts: { [B]: { status: "reverted", logs: [] } },
    });
    const res = await rescueAll(deps);
    expect(res[0]).toEqual({ token: A, hash: hashOf(41), amount: 1n, expected: 1n, success: true });
    expect(res[1]).toEqual({ token: B, hash: hashOf(42), amount: 0n, expected: 2n, success: false, error: "rescue tx reverted" });
  });

  it("reports the Rescued log amount from the receipt, not the pre-read estimate", async () => {
    // An attacker raced the rescue: the vault moved less than the pre-read.
    const { deps } = makeDeps({ balances: { [A]: 10n }, receipts: { [A]: { status: "success", logs: [rescuedLog(A, 3n)] } } });
    expect(await rescueAll(deps)).toEqual([{ token: A, hash: hashOf(41), amount: 3n, expected: 10n, success: true }]);
  });

  it("ignores Rescued logs from another address or for another token", async () => {
    const stranger = "0x00000000000000000000000000000000000000ee" as const;
    const { deps } = makeDeps({
      balances: { [A]: 10n },
      receipts: { [A]: { status: "success", logs: [rescuedLog(A, 10n, stranger), rescuedLog(B, 10n), rescuedLog(A, 4n)] } },
    });
    expect((await rescueAll(deps))[0]).toMatchObject({ amount: 4n, success: true });
  });

  it("matches the vault address case-insensitively", async () => {
    const { deps } = makeDeps({
      balances: { [A]: 10n },
      receipts: { [A]: { status: "success", logs: [rescuedLog(A, 10n, VAULT.toLowerCase() as Hex)] } },
    });
    expect((await rescueAll(deps))[0].amount).toBe(10n);
  });

  it("reports a send error for that token only and reuses its nonce for the next token", async () => {
    const { deps, signTx } = makeDeps({ balances: { [A]: 1n, [B]: 2n, [C]: 3n }, sendThrows: { [B]: new Error("rpc down") } });
    const res = await rescueAll(deps);
    expect(signTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42, 42]);
    expect(res).toEqual([
      { token: A, hash: hashOf(41), amount: 1n, expected: 1n, success: true },
      { token: B, hash: "", amount: 0n, expected: 2n, success: false, error: "rpc down" },
      { token: C, hash: hashOf(42), amount: 3n, expected: 3n, success: true },
    ]);
  });

  it("reports a receipt wait error with the tx hash kept", async () => {
    const { deps } = makeDeps({ balances: { [A]: 1n }, receipts: { [A]: new Error("timed out") } });
    expect(await rescueAll(deps)).toEqual([{ token: A, hash: hashOf(41), amount: 0n, expected: 1n, success: false, error: "timed out" }]);
  });

  it("reports every token as failed when preparing or reading the nonce fails, and sends nothing", async () => {
    const n = makeDeps({ balances: { [A]: 1n, [B]: 2n }, nonceThrows: new Error("no rpc") });
    expect(await rescueAll(n.deps)).toEqual([
      { token: A, hash: "", amount: 0n, expected: 1n, success: false, error: "no rpc" },
      { token: B, hash: "", amount: 0n, expected: 2n, success: false, error: "no rpc" },
    ]);
    expect(n.signTx).not.toHaveBeenCalled();

    const p = makeDeps({ balances: { [A]: 1n } });
    p.prepare.mockRejectedValueOnce(new Error("window refused"));
    expect(await rescueAll(p.deps)).toEqual([{ token: A, hash: "", amount: 0n, expected: 1n, success: false, error: "window refused" }]);
    expect(p.signTx).not.toHaveBeenCalled();
    expect(p.sendRaw).not.toHaveBeenCalled();
  });

  it("keeps a tx the node took although the send call failed: hash reported, nonce consumed", async () => {
    const { deps, signTx } = makeDeps({ balances: { [A]: 1n, [B]: 2n }, takenDespiteError: [A] });
    const res = await rescueAll(deps);
    expect(signTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42]);
    expect(res).toEqual([
      { token: A, hash: hashOf(41), amount: 1n, expected: 1n, success: true },
      { token: B, hash: hashOf(42), amount: 2n, expected: 2n, success: true },
    ]);
  });

  it("reports every token failed without preparing anything when all reads fail", async () => {
    const boom = new Error("rpc 502");
    const { deps, prepare, signTx } = makeDeps({ balances: { [A]: 1n, [B]: 2n }, readThrows: { [A]: boom, [B]: boom, [C]: boom } });
    const res = await rescueAll(deps);
    expect(res.map((r) => [r.token, r.success, r.error])).toEqual([
      [A, false, "read failed: rpc 502"],
      [B, false, "read failed: rpc 502"],
      [C, false, "read failed: rpc 502"],
    ]);
    expect(prepare).not.toHaveBeenCalled();
    expect(signTx).not.toHaveBeenCalled();
  });

  it("keeps each tx's own result when two token slots share an address", async () => {
    const { deps, signTx } = makeDeps({ balances: { [A]: 1n } });
    deps.tokens = [A, A];
    const res = await rescueAll(deps);
    expect(signTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42]);
    expect(res.map((r) => r.hash)).toEqual([hashOf(41), hashOf(42)]);
  });

  it("reports a token whose read fails as failed and still rescues the others", async () => {
    const { deps, signTx } = makeDeps({ balances: { [A]: 1n, [B]: 2n, [C]: 3n }, readThrows: { [B]: new Error("rpc 502") } });
    const res = await rescueAll(deps);
    expect(signTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42]);
    expect(res).toEqual([
      { token: A, hash: hashOf(41), amount: 1n, expected: 1n, success: true },
      { token: B, hash: "", amount: 0n, expected: 0n, success: false, error: "read failed: rpc 502" },
      { token: C, hash: hashOf(42), amount: 3n, expected: 3n, success: true },
    ]);
  });
});

describe("productionDeps", () => {
  // A throwaway test key (never funded, never used on any chain).
  const TEST_KEY = `0x${"11".repeat(32)}` as Hex;
  const OWNER = "0x00000000000000000000000000000000000000aa" as const;
  const cfg = { owner: OWNER, vault: VAULT, tokens: { fUSD: A, fETH: B, fBTC: C }, gas: { privateKey: TEST_KEY } } as unknown as AgentConfig;

  it("sends all 6 balance/allowance reads and the nonce read in ONE HTTP request, and nothing when all are 0 (RF1)", async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const reply = (r: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: r.id,
        result: r.method === "eth_getTransactionCount" ? "0x29" : `0x${"0".repeat(64)}`,
      });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "content-type": "application/json" } });
    });
    const keeper = { ensureIfStale: vi.fn(async () => false), invalidate: vi.fn() };
    const deps = productionDeps(cfg, keeper, undefined, createBatchClient(fetchFn as unknown as typeof fetch));
    expect(await rescueAll(deps, A)).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const batch = bodies[0] as { method: string }[];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.map((r) => r.method).sort()).toEqual([...Array(6).fill("eth_call"), "eth_getTransactionCount"]);
    expect(keeper.ensureIfStale).not.toHaveBeenCalled();
    expect(keeper.invalidate).not.toHaveBeenCalled();
  });
});
