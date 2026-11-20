import { describe, expect, it, vi } from "vitest";
import { RESCUE_SELECTOR } from "@qday/core";
import { decodeFunctionData } from "viem";
import { vaultAbi } from "@qday/core";
import { rescueAll, rescueCall, type RescueDeps } from "../src/rescue";

const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const C = "0x00000000000000000000000000000000000000c3" as const;

function makeDeps(over: {
  balances?: Record<string, bigint>;
  allowances?: Record<string, bigint>;
  exec?: { success: boolean; error?: string }[];
  broadcastThrows?: Error;
  rescued?: Record<string, bigint>;
  height?: number | undefined;
} = {}) {
  const balances = over.balances ?? { [A]: 10n, [B]: 20n, [C]: 30n };
  const allowances = over.allowances ?? { [A]: 10n ** 30n, [B]: 10n ** 30n, [C]: 10n ** 30n };
  const readRescuedCalls: [string, bigint][] = [];
  const fetchAuthState = vi.fn(async () => ({ nonce: 5n, digestVersion: "v2" }));
  const buildMsg = vi.fn(async (token: `0x${string}`, nonce: bigint, _dv: string) => ({ typeUrl: "t", value: { token, nonce } }));
  const broadcast = vi.fn(async (msgs: unknown[]) => {
    if (over.broadcastThrows) throw over.broadcastThrows;
    return { hash: "TXHASH", height: "height" in over ? over.height : 100, executions: over.exec ?? msgs.map(() => ({ success: true })) };
  });
  const deps: RescueDeps = {
    tokens: [A, B, C],
    readBalance: async (t) => balances[t] ?? 0n,
    readAllowance: async (t) => allowances[t] ?? 0n,
    fetchAuthState,
    buildMsg,
    broadcast,
    readRescued: async (t, h) => {
      readRescuedCalls.push([t, h]);
      if (over.rescued) return over.rescued[t] ?? 0n;
      const b = balances[t] ?? 0n, a = allowances[t] ?? 0n;
      return b < a ? b : a; // an honest vault moves min(balance, allowance)
    },
  };
  return { deps, fetchNonce: fetchAuthState, buildMsg, broadcast, readRescuedCalls };
}

describe("rescueAll", () => {
  it("test_skipsTokensWithZeroOwnerBalance", async () => {
    const { deps, fetchNonce, broadcast } = makeDeps({ balances: {} });
    expect(await rescueAll(deps)).toEqual([]);
    expect(fetchNonce).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("test_skipsTokenWithZeroAllowance", async () => {
    const { deps, buildMsg } = makeDeps({ allowances: { [A]: 0n, [B]: 10n ** 30n, [C]: 10n ** 30n } });
    const res = await rescueAll(deps);
    expect(res.map((r) => r.token)).toEqual([B, C]);
    expect(buildMsg).toHaveBeenCalledTimes(2);
  });

  it("test_batchesRemainingTokensWithSequentialNonces", async () => {
    const { deps, buildMsg, broadcast, fetchNonce } = makeDeps({ allowances: { [A]: 7n, [B]: 10n ** 30n, [C]: 10n ** 30n } });
    const res = await rescueAll(deps);
    expect(fetchNonce).toHaveBeenCalledTimes(1);
    expect(buildMsg.mock.calls).toEqual([[A, 5n, "v2"], [B, 6n, "v2"], [C, 7n, "v2"]]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toHaveLength(3);
    // amount = min(balance, allowance)
    expect(res).toEqual([
      { token: A, hash: "TXHASH", amount: 7n, expected: 7n, success: true },
      { token: B, hash: "TXHASH", amount: 20n, expected: 20n, success: true },
      { token: C, hash: "TXHASH", amount: 30n, expected: 30n, success: true },
    ]);
  });

  it("test_reportsFailedExecution", async () => {
    const { deps } = makeDeps({
      balances: { [A]: 1n, [B]: 2n },
      exec: [{ success: true }, { success: false, error: "execution reverted" }],
    });
    const res = await rescueAll(deps);
    expect(res).toEqual([
      { token: A, hash: "TXHASH", amount: 1n, expected: 1n, success: true },
      { token: B, hash: "TXHASH", amount: 0n, expected: 2n, success: false, error: "execution reverted" },
    ]);
  });

  it("reports every token as failed when the broadcast itself throws", async () => {
    const { deps } = makeDeps({ balances: { [A]: 1n }, broadcastThrows: new Error("rpc down") });
    expect(await rescueAll(deps)).toEqual([{ token: A, hash: "", amount: 0n, expected: 1n, success: false, error: "rpc down" }]);
  });

  it("reports a missing execution result as failed", async () => {
    const { deps } = makeDeps({ balances: { [A]: 1n, [B]: 2n }, exec: [{ success: true }] });
    const res = await rescueAll(deps);
    expect(res[1].success).toBe(false);
  });

  it("reports the Rescued log amount, not the pre-read estimate", async () => {
    // Execution succeeded but an attacker raced in the same block: the vault moved less.
    const { deps, readRescuedCalls } = makeDeps({ balances: { [A]: 10n }, rescued: { [A]: 3n } });
    const res = await rescueAll(deps);
    expect(res).toEqual([{ token: A, hash: "TXHASH", amount: 3n, expected: 10n, success: true }]);
    expect(readRescuedCalls).toEqual([[A, 100n]]);
  });

  it("reports amount 0 when no Rescued log is found, or the height is unknown", async () => {
    const none = makeDeps({ balances: { [A]: 10n }, rescued: {} });
    expect((await rescueAll(none.deps))[0].amount).toBe(0n);
    const noHeight = makeDeps({ balances: { [A]: 10n }, height: undefined });
    const r = await rescueAll(noHeight.deps);
    expect(r[0].amount).toBe(0n);
    expect(noHeight.readRescuedCalls).toEqual([]);
  });

  it("reports amount 0 when reading the Rescued logs fails", async () => {
    const { deps } = makeDeps({ balances: { [A]: 10n } });
    deps.readRescued = async () => { throw new Error("rpc"); };
    expect((await rescueAll(deps))[0]).toMatchObject({ amount: 0n, expected: 10n, success: true });
  });

  it("resolves auth state (nonce + digest version) once per run", async () => {
    const { deps, fetchNonce } = makeDeps();
    await rescueAll(deps);
    expect(fetchNonce).toHaveBeenCalledTimes(1);
  });
});

describe("rescueCall (hard rule: the agent can only call vault.rescue(token))", () => {
  it("targets the vault with rescue(token), no value, tight gas", () => {
    const vault = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
    const call = rescueCall(vault, A);
    expect(call.to).toBe(vault);
    expect(call.value).toBe("0");
    expect(call.gasLimit).toBe(200_000n);
    expect(call.data.slice(0, 10)).toBe(RESCUE_SELECTOR);
    const d = decodeFunctionData({ abi: vaultAbi, data: call.data });
    expect(d.functionName).toBe("rescue");
    expect((d.args as unknown as string[]).map((x) => x.toLowerCase())).toEqual([A]);
  });
});
