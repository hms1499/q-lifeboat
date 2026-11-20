import { describe, expect, it, vi } from "vitest";
import { RESCUE_SELECTOR, vaultAbi } from "@qday/core";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { RESCUE_GAS, rescueAll, type RescueDeps, type RescueReceipt, type RescueTx } from "../src/rescue";

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
  nonceThrows?: Error;
} = {}) {
  const balances = over.balances ?? { [A]: 10n, [B]: 20n, [C]: 30n };
  const allowances = over.allowances ?? { [A]: 10n ** 30n, [B]: 10n ** 30n, [C]: 10n ** 30n };
  const tokenByHash = new Map<Hex, Hex>();
  const order: string[] = [];
  const prepare = vi.fn(async () => { order.push("prepare"); });
  const fetchNonce = vi.fn(async () => {
    order.push("nonce");
    if (over.nonceThrows) throw over.nonceThrows;
    return 41;
  });
  const sendTx = vi.fn(async (tx: RescueTx) => {
    const token = (decodeFunctionData({ abi: vaultAbi, data: tx.data }).args as readonly Hex[])[0].toLowerCase() as Hex;
    order.push(`send:${token}`);
    const err = over.sendThrows?.[token];
    if (err) throw err;
    const hash = hashOf(tx.nonce);
    tokenByHash.set(hash, token);
    return hash;
  });
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
    readBalance: async (t) => balances[t] ?? 0n,
    readAllowance: async (t) => allowances[t] ?? 0n,
    prepare,
    fetchNonce,
    sendTx,
    waitReceipt,
  };
  return { deps, prepare, fetchNonce, sendTx, waitReceipt, order };
}

describe("rescueAll", () => {
  it("test_skipsTokensWithZeroOwnerBalance", async () => {
    const { deps, prepare, fetchNonce, sendTx } = makeDeps({ balances: {} });
    expect(await rescueAll(deps)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchNonce).not.toHaveBeenCalled();
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("test_skipsTokenWithZeroAllowance", async () => {
    const { deps, sendTx } = makeDeps({ allowances: { [A]: 0n, [B]: 10n ** 30n, [C]: 10n ** 30n } });
    const res = await rescueAll(deps);
    expect(res.map((r) => r.token)).toEqual([B, C]);
    expect(sendTx).toHaveBeenCalledTimes(2);
  });

  it("sends one tx per token with sequential nonces, all before waiting for receipts", async () => {
    const { deps, sendTx, fetchNonce, order } = makeDeps({ allowances: { [A]: 7n, [B]: 10n ** 30n, [C]: 10n ** 30n } });
    const res = await rescueAll(deps);
    expect(fetchNonce).toHaveBeenCalledTimes(1);
    expect(sendTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42, 43]);
    expect(order).toEqual(["prepare", "nonce", `send:${A}`, `send:${B}`, `send:${C}`, "wait", "wait", "wait"]);
    expect(res).toEqual([
      { token: A, hash: hashOf(41), amount: 7n, expected: 7n, success: true },
      { token: B, hash: hashOf(42), amount: 20n, expected: 20n, success: true },
      { token: C, hash: hashOf(43), amount: 30n, expected: 30n, success: true },
    ]);
  });

  it("locks the calldata: to = vault, rescue(token), no value, tight gas", async () => {
    const { deps, sendTx } = makeDeps({ balances: { [A]: 1n, [B]: 2n } });
    await rescueAll(deps);
    expect(RESCUE_GAS).toBe(120_000n);
    for (const [[tx], token] of sendTx.mock.calls.map((c, i) => [c, [A, B][i]] as const)) {
      expect(Object.keys(tx).sort()).toEqual(["data", "gas", "nonce", "to"]);
      expect(tx.to).toBe(VAULT);
      expect(tx.gas).toBe(RESCUE_GAS);
      expect(tx.data.slice(0, 10)).toBe(RESCUE_SELECTOR);
      const d = decodeFunctionData({ abi: vaultAbi, data: tx.data });
      expect(d.functionName).toBe("rescue");
      expect((d.args as readonly string[]).map((x) => x.toLowerCase())).toEqual([token]);
    }
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
    const { deps, sendTx } = makeDeps({ balances: { [A]: 1n, [B]: 2n, [C]: 3n }, sendThrows: { [B]: new Error("rpc down") } });
    const res = await rescueAll(deps);
    expect(sendTx.mock.calls.map(([tx]) => tx.nonce)).toEqual([41, 42, 42]);
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
    expect(n.sendTx).not.toHaveBeenCalled();

    const p = makeDeps({ balances: { [A]: 1n } });
    p.prepare.mockRejectedValueOnce(new Error("window refused"));
    expect(await rescueAll(p.deps)).toEqual([{ token: A, hash: "", amount: 0n, expected: 1n, success: false, error: "window refused" }]);
    expect(p.fetchNonce).not.toHaveBeenCalled();
    expect(p.sendTx).not.toHaveBeenCalled();
  });
});
