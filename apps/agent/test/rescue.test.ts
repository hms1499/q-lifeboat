import { describe, expect, it, vi } from "vitest";
import { rescueAll, type RescueDeps } from "../src/rescue";

const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const C = "0x00000000000000000000000000000000000000c3" as const;

function makeDeps(over: {
  balances?: Record<string, bigint>;
  allowances?: Record<string, bigint>;
  exec?: { success: boolean; error?: string }[];
  broadcastThrows?: Error;
} = {}) {
  const balances = over.balances ?? { [A]: 10n, [B]: 20n, [C]: 30n };
  const allowances = over.allowances ?? { [A]: 10n ** 30n, [B]: 10n ** 30n, [C]: 10n ** 30n };
  const fetchNonce = vi.fn(async () => 5n);
  const buildMsg = vi.fn(async (token: `0x${string}`, nonce: bigint) => ({ typeUrl: "t", value: { token, nonce } }));
  const broadcast = vi.fn(async (msgs: unknown[]) => {
    if (over.broadcastThrows) throw over.broadcastThrows;
    return { hash: "TXHASH", executions: over.exec ?? msgs.map(() => ({ success: true })) };
  });
  const deps: RescueDeps = {
    tokens: [A, B, C],
    readBalance: async (t) => balances[t] ?? 0n,
    readAllowance: async (t) => allowances[t] ?? 0n,
    fetchNonce,
    buildMsg,
    broadcast,
  };
  return { deps, fetchNonce, buildMsg, broadcast };
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
    expect(buildMsg.mock.calls).toEqual([[A, 5n], [B, 6n], [C, 7n]]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toHaveLength(3);
    // amount = min(balance, allowance)
    expect(res).toEqual([
      { token: A, hash: "TXHASH", amount: 7n, success: true },
      { token: B, hash: "TXHASH", amount: 20n, success: true },
      { token: C, hash: "TXHASH", amount: 30n, success: true },
    ]);
  });

  it("test_reportsFailedExecution", async () => {
    const { deps } = makeDeps({
      balances: { [A]: 1n, [B]: 2n },
      exec: [{ success: true }, { success: false, error: "execution reverted" }],
    });
    const res = await rescueAll(deps);
    expect(res).toEqual([
      { token: A, hash: "TXHASH", amount: 1n, success: true },
      { token: B, hash: "TXHASH", amount: 2n, success: false, error: "execution reverted" },
    ]);
  });

  it("reports every token as failed when the broadcast itself throws", async () => {
    const { deps } = makeDeps({ balances: { [A]: 1n }, broadcastThrows: new Error("rpc down") });
    expect(await rescueAll(deps)).toEqual([{ token: A, hash: "", amount: 1n, success: false, error: "rpc down" }]);
  });

  it("reports a missing execution result as failed", async () => {
    const { deps } = makeDeps({ balances: { [A]: 1n, [B]: 2n }, exec: [{ success: true }] });
    const res = await rescueAll(deps);
    expect(res[1].success).toBe(false);
  });
});
