import { evmWindowCost } from "@qorechain/evm";
import { openEvmWindowMsg } from "@qorechain/sdk";
import { describe, expect, it, vi } from "vitest";
import { RESCUE_GAS } from "../src/rescue";
import { buildGuardianWindowParams, createSerial, createWindowKeeper, needsWindow, type WindowStatus } from "../src/window";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const ONE_TX = evmWindowCost({ gas: RESCUE_GAS, maxFeePerGas: 112_500_000_000n });
const healthy: WindowStatus = { live: true, remainingBlocks: 500n, remainingTxs: 8n, remainingValue: ONE_TX * 8n };

describe("needsWindow", () => {
  it("is false for a healthy window", () => {
    expect(needsWindow(healthy)).toBe(false);
    expect(needsWindow({ ...healthy, remainingBlocks: 100n, remainingTxs: 3n, remainingValue: ONE_TX * 3n })).toBe(false);
  });

  it("is true when the window is not live", () => {
    expect(needsWindow({ ...healthy, live: false })).toBe(true);
  });

  it("is true when fewer than 100 blocks remain", () => {
    expect(needsWindow({ ...healthy, remainingBlocks: 99n })).toBe(true);
  });

  it("is true when fewer than 3 txs remain", () => {
    expect(needsWindow({ ...healthy, remainingTxs: 2n })).toBe(true);
  });

  it("is true when the value left cannot pay for 3 rescue txs", () => {
    expect(needsWindow({ ...healthy, remainingValue: ONE_TX * 3n - 1n })).toBe(true);
  });
});

describe("buildGuardianWindowParams", () => {
  const p = buildGuardianWindowParams("qor1guardian", VAULT);

  it("opens 600 blocks / 10 txs scoped to the vault only", () => {
    expect(p).toEqual({
      sender: "qor1guardian",
      blocks: 600,
      maxTxs: 10,
      maxValue: (ONE_TX * 10n).toString(),
      allowedTargets: [VAULT],
    });
  });

  it("passes the SDK bounds check with the vault as the only target", () => {
    const msg = openEvmWindowMsg(p);
    expect(msg.typeUrl).toBe("/qorechain.pqc.v1.MsgOpenEVMWindow");
    expect((msg.value as { allowedTargets: string[] }).allowedTargets.map((a) => a.toLowerCase())).toEqual([VAULT.toLowerCase()]);
  });
});

function keeper(statuses: WindowStatus[]) {
  const queue = [...statuses];
  const readStatus = vi.fn(async () => queue.shift() ?? healthy);
  const open = vi.fn(async () => "OPENHASH");
  const log = vi.fn();
  return { k: createWindowKeeper({ readStatus, open, log }), readStatus, open, log };
}

describe("createWindowKeeper", () => {
  it("ensure() does nothing more than a read when the window is healthy", async () => {
    const { k, readStatus, open } = keeper([healthy]);
    await k.ensure();
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("ensure() opens ONE window when needed and checks the result", async () => {
    const { k, readStatus, open, log } = keeper([{ ...healthy, live: false }, healthy]);
    await k.ensure();
    expect(open).toHaveBeenCalledTimes(1);
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(" ")).toContain("OPENHASH");
  });

  it("ensure() throws when the window cannot be opened or is still unusable", async () => {
    const refused = keeper([{ ...healthy, live: false }]);
    refused.open.mockRejectedValueOnce(new Error("tx refused"));
    await expect(refused.k.ensure()).rejects.toThrow(/tx refused/);

    const stillBad = keeper([{ ...healthy, live: false }, { ...healthy, remainingTxs: 0n }]);
    await expect(stillBad.k.ensure()).rejects.toThrow(/not usable/);
  });

  it("ensureIfStale() trusts a healthy cached status (no REST read)", async () => {
    const { k, readStatus } = keeper([healthy]);
    await k.ensure();
    await k.ensureIfStale();
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it("ensureIfStale() reads again with no cache, after invalidate(), or when the cache is unusable", async () => {
    const fresh = keeper([]);
    await fresh.k.ensureIfStale();
    expect(fresh.readStatus).toHaveBeenCalledTimes(1);

    const inv = keeper([healthy, healthy]);
    await inv.k.ensure();
    inv.k.invalidate();
    await inv.k.ensureIfStale();
    expect(inv.readStatus).toHaveBeenCalledTimes(2);

    const low = { ...healthy, remainingBlocks: 1n };
    const bad = keeper([low, low, healthy]);
    await expect(bad.k.ensure()).rejects.toThrow(/not usable/);
    await bad.k.ensureIfStale();
    expect(bad.readStatus).toHaveBeenCalledTimes(3);
    expect(bad.open).toHaveBeenCalledTimes(1);
  });
});

describe("createSerial", () => {
  it("runs tasks one at a time, and a failed task does not block the next", async () => {
    const serial = createSerial();
    const events: string[] = [];
    let release!: () => void;
    const first = serial(async () => {
      events.push("a:start");
      await new Promise<void>((r) => (release = r));
      events.push("a:end");
      throw new Error("a failed");
    });
    const second = serial(async () => {
      events.push("b");
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);
    release();
    await expect(first).rejects.toThrow("a failed");
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["a:start", "a:end", "b"]);
  });
});
