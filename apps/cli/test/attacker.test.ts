import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  attack,
  DRAIN_AMOUNT,
  DRAIN_COUNT,
  DRAIN_GAS,
  FORGED_SIG_BYTES,
  MISUSE_AMOUNT,
  OWNER_WINDOW_TXS_USED,
  type AttackDeps,
} from "../src/attacker";
import { WINDOW_MAX_TXS } from "../src/setup";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const REFUSAL =
  "a linked key with a spending rule may call 0x8478 with data only if the rule lists the call in allowed_evm_calls: authenticator not permitted for this action";

function makeDeps(over: Partial<AttackDeps> = {}) {
  const order: string[] = [];
  let sent = 0;
  const deps: AttackDeps = {
    log: () => {},
    sendDrain: vi.fn(async () => {
      sent += 1;
      order.push(`send${sent}`);
      return h(sent);
    }),
    waitReceipt: vi.fn(async (hash: Hex) => {
      order.push(`wait${Number(BigInt(hash))}`);
      return { status: "success" as const, blockNumber: 100n + BigInt(hash) };
    }),
    vaultTokenBalance: vi.fn(async () => 80n * 10n ** 18n),
    simulateWithdraw: vi.fn(async () => "BadSignature"),
    sendWithdraw: vi.fn(async () => h(0xf0)),
    misuse: vi.fn(async () => ({ tx: "MISUSE", height: 5, executions: [{ success: false, error: REFUSAL }], code: 0 as const, reason: REFUSAL })),
    randomBytes: vi.fn((n: number) => new Uint8Array(n).fill(7)),
    ...over,
  };
  return { deps, order };
}

describe("attack constants", () => {
  it("drains 3 x 10 fUSD with a tight explicit gas limit, misuses 1 fUSD, forges a 4627-byte signature", () => {
    expect(DRAIN_COUNT).toBe(3);
    expect(DRAIN_AMOUNT).toBe(10n * 10n ** 18n);
    expect(DRAIN_GAS).toBe(60_000n);
    expect(MISUSE_AMOUNT).toBe(10n ** 18n);
    expect(FORGED_SIG_BYTES).toBe(4627);
  });

  it("fits the owner's scoped setup window: 3 approvals + 3 drains + 1 forged withdraw + 1 recovery withdraw <= 10", () => {
    expect(OWNER_WINDOW_TXS_USED).toBe(8);
    expect(OWNER_WINDOW_TXS_USED).toBeLessThanOrEqual(WINDOW_MAX_TXS);
  });
});

describe("revertName", () => {
  it("decodes the vault's custom error from a contract revert (BadSignature = 0x5cd5d233)", async () => {
    const { vaultAbi } = await import("@qday/core");
    const { ContractFunctionExecutionError, ContractFunctionRevertedError } = await import("viem");
    const { revertName } = await import("../src/attacker");
    const inner = new ContractFunctionRevertedError({ abi: vaultAbi, data: "0x5cd5d233", functionName: "withdraw" });
    expect(revertName(inner)).toBe("BadSignature");
    const wrapped = new ContractFunctionExecutionError(inner, { abi: vaultAbi, functionName: "withdraw", args: [] });
    expect(revertName(wrapped)).toBe("BadSignature");
    expect(revertName(new Error("socket hang up"))).toBe("socket hang up");
  });
});

describe("attack: drain", () => {
  it("sends drain k+1 only once drain k has a receipt (one block apart), and records hash, block, status", async () => {
    const { deps, order } = makeDeps();
    const r = await attack(deps);
    expect(order.slice(0, 6)).toEqual(["send1", "wait1", "send2", "wait2", "send3", "wait3"]);
    expect(r.drains).toEqual([
      { index: 1, hash: h(1), block: "101", status: "success" },
      { index: 2, hash: h(2), block: "102", status: "success" },
      { index: 3, hash: h(3), block: "103", status: "success" },
    ]);
  });

  it("records a refused or reverted drain and keeps going", async () => {
    let n = 0;
    const { deps } = makeDeps({
      sendDrain: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new Error("EVM authorisation window exhausted");
        return h(n);
      }),
      waitReceipt: vi.fn(async (hash: Hex) => ({ status: hash === h(3) ? ("reverted" as const) : ("success" as const), blockNumber: 7n })),
    });
    const r = await attack(deps);
    expect(r.drains).toEqual([
      { index: 1, hash: h(1), block: "7", status: "success" },
      { index: 2, error: "EVM authorisation window exhausted" },
      { index: 3, hash: h(3), block: "7", status: "reverted" },
    ]);
    expect(deps.sendWithdraw).toHaveBeenCalledOnce(); // the attack went on
  });

  it("keeps the hash when the receipt wait fails", async () => {
    const { deps } = makeDeps({ waitReceipt: vi.fn(async () => { throw new Error("timeout"); }) });
    const r = await attack(deps);
    expect(r.drains[0]).toEqual({ index: 1, hash: h(1), error: "timeout" });
  });
});

describe("attack: (a) forged withdraw", () => {
  it("eth_calls then sends withdraw(vault balance) with random 4627 bytes; passes on BadSignature + reverted receipt", async () => {
    const { deps } = makeDeps({
      waitReceipt: vi.fn(async (hash: Hex) => ({ status: hash === h(0xf0) ? ("reverted" as const) : ("success" as const), blockNumber: 200n })),
    });
    const r = await attack(deps);
    expect(deps.randomBytes).toHaveBeenCalledWith(4627);
    const [amount, sig] = vi.mocked(deps.simulateWithdraw).mock.calls[0];
    expect(amount).toBe(80n * 10n ** 18n);
    expect(sig).toHaveLength(2 + 2 * 4627);
    expect(vi.mocked(deps.sendWithdraw).mock.calls[0]).toEqual([amount, sig]);
    expect(r.forged).toEqual({ amount: (80n * 10n ** 18n).toString(), revert: "BadSignature", hash: h(0xf0), block: "200", status: "reverted", pass: true });
  });

  it("asks for 1 fUSD when the vault is empty", async () => {
    const { deps } = makeDeps({ vaultTokenBalance: vi.fn(async () => 0n) });
    await attack(deps);
    expect(vi.mocked(deps.simulateWithdraw).mock.calls[0][0]).toBe(10n ** 18n);
  });

  it("fails when the revert is not BadSignature, when the tx did not revert, or when it could not be sent", async () => {
    const reverted = vi.fn(async () => ({ status: "reverted" as const, blockNumber: 1n }));
    const other = makeDeps({ simulateWithdraw: vi.fn(async () => "KeyNotProven"), waitReceipt: reverted });
    expect((await attack(other.deps)).forged.pass).toBe(false);

    const succeeded = makeDeps(); // receipt status success: the forged withdraw went through
    expect((await attack(succeeded.deps)).forged.pass).toBe(false);

    const unsent = makeDeps({ sendWithdraw: vi.fn(async () => { throw new Error("window exhausted"); }), waitReceipt: reverted });
    const r = await attack(unsent.deps);
    expect(r.forged).toMatchObject({ revert: "BadSignature", error: "window exhausted", pass: false });
  });

  it("records a simulation that did not revert as revert null", async () => {
    const { deps } = makeDeps({ simulateWithdraw: vi.fn(async () => null) });
    expect((await attack(deps)).forged).toMatchObject({ revert: null, pass: false });
  });
});

describe("attack: (b) agent key misuse", () => {
  it("passes only on a call-policy refusal with the chain's exact phrase", async () => {
    const ok = makeDeps();
    expect((await attack(ok.deps)).misuse).toEqual({ tx: "MISUSE", reason: REFUSAL, executions: [{ success: false, error: REFUSAL }], pass: true });

    const vague = makeDeps({ misuse: vi.fn(async () => ({ tx: "T", executions: [{ success: false, error: "Not Permitted" }], code: 0 as const, reason: "Not Permitted" })) });
    expect((await attack(vague.deps)).misuse.pass).toBe(false);

    const moved = makeDeps({ misuse: vi.fn(async () => ({ tx: "T", executions: [{ success: true }], code: 2 as const, reason: "none" })) });
    expect((await attack(moved.deps)).misuse.pass).toBe(false);
  });

  it("records a misuse attempt that throws", async () => {
    const { deps } = makeDeps({ misuse: vi.fn(async () => { throw new Error("GAS_MNEMONIC is not set"); }) });
    expect((await attack(deps)).misuse).toEqual({ reason: "", executions: [], pass: false, error: "GAS_MNEMONIC is not set" });
  });

  it("runs after the drains and the forged withdraw", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      sendWithdraw: vi.fn(async () => { order.push("withdraw"); return h(0xf0); }),
      misuse: vi.fn(async () => { order.push("misuse"); return { tx: "T", executions: [], code: 1 as const, reason: "none" }; }),
    });
    vi.mocked(deps.sendDrain).mockImplementation(async () => { order.push("drain"); return h(1); });
    await attack(deps);
    expect(order).toEqual(["drain", "drain", "drain", "withdraw", "misuse"]);
  });
});
