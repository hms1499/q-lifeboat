import { evmWindowCost } from "@qorechain/evm";
import { openEvmWindowMsg } from "@qorechain/sdk";
import { describe, expect, it, vi } from "vitest";
import { RESCUE_GAS, RESCUE_MAX_FEE_PER_GAS } from "../src/rescue";
import {
  buildGuardianWindowParams,
  createOnDemandWatcher,
  createSerial,
  createWindowKeeper,
  guardianBlocksFor,
  needsWindow,
  pollUntil,
  skipWhileBusy,
  STATUS_POLLS,
  type WindowStatus,
} from "../src/window";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const ONE_TX = evmWindowCost({ gas: RESCUE_GAS, maxFeePerGas: RESCUE_MAX_FEE_PER_GAS });
const OLD_VAULT = "0x776913Abe058941d4c8ac097EE47E29F528f71e6" as const;
const healthy: WindowStatus = { live: true, remainingBlocks: 500n, remainingTxs: 8n, remainingValue: ONE_TX * 8n, allowedTargets: [VAULT] };

describe("needsWindow", () => {
  it("is false for a healthy window", () => {
    expect(needsWindow(healthy, VAULT)).toBe(false);
    expect(needsWindow({ ...healthy, remainingBlocks: 100n, remainingTxs: 3n, remainingValue: ONE_TX * 3n }, VAULT)).toBe(false);
  });

  it("is true when the window is not live", () => {
    expect(needsWindow({ ...healthy, live: false }, VAULT)).toBe(true);
  });

  it("is true when fewer than 100 blocks remain", () => {
    expect(needsWindow({ ...healthy, remainingBlocks: 99n }, VAULT)).toBe(true);
  });

  it("is true when fewer than 3 txs remain", () => {
    expect(needsWindow({ ...healthy, remainingTxs: 2n }, VAULT)).toBe(true);
  });

  it("is true when the value left cannot pay for 3 rescue txs", () => {
    expect(needsWindow({ ...healthy, remainingValue: ONE_TX * 3n - 1n }, VAULT)).toBe(true);
  });
});

describe("needsWindow vault target", () => {
  it("is true when the live window targets another vault (each fresh demo run deploys a new one)", () => {
    expect(needsWindow({ ...healthy, allowedTargets: [OLD_VAULT] }, VAULT)).toBe(true);
  });

  it("is true for an unscoped window (empty targets): the guardian's window must name the vault", () => {
    expect(needsWindow({ ...healthy, allowedTargets: [] }, VAULT)).toBe(true);
  });

  it("matches the vault case-insensitively, among other targets", () => {
    expect(needsWindow({ ...healthy, allowedTargets: [OLD_VAULT, VAULT.toLowerCase()] }, VAULT)).toBe(false);
  });
});

describe("buildGuardianWindowParams", () => {
  const p = buildGuardianWindowParams("qor1guardian", VAULT);

  it("opens 14400 blocks (~5.7 h) / 10 txs scoped to the vault only, budgeted at the rescue fee cap", () => {
    expect(p).toEqual({
      sender: "qor1guardian",
      blocks: 14_400,
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
  const sleep = vi.fn(async () => {});
  return { k: createWindowKeeper({ vault: VAULT, readStatus, open, log, sleep }), readStatus, open, log, sleep };
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

  it("ensure() opens a new window when the live one targets another vault", async () => {
    const { k, open } = keeper([{ ...healthy, allowedTargets: [OLD_VAULT] }, healthy]);
    await k.ensure();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("ensure() throws when the window cannot be opened or is still unusable", async () => {
    const refused = keeper([{ ...healthy, live: false }]);
    refused.open.mockRejectedValueOnce(new Error("tx refused"));
    await expect(refused.k.ensure()).rejects.toThrow(/tx refused/);

    const used = { ...healthy, remainingTxs: 0n };
    const stillBad = keeper([{ ...healthy, live: false }, ...Array(STATUS_POLLS).fill(used)]);
    await expect(stillBad.k.ensure()).rejects.toThrow(/not usable/);
    expect(stillBad.readStatus).toHaveBeenCalledTimes(1 + STATUS_POLLS);
  });

  it("ensure() re-reads a stale status after opening instead of failing at once", async () => {
    const dead = { ...healthy, live: false };
    const { k, readStatus, open, sleep } = keeper([dead, dead, healthy]);
    await k.ensure();
    expect(open).toHaveBeenCalledTimes(1);
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("ensureIfStale() trusts a healthy cached status (no REST read)", async () => {
    const { k, readStatus } = keeper([healthy]);
    await k.ensure();
    await k.ensureIfStale();
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it("ensure() and ensureIfStale() resolve true only when they opened a window (the guardian's nonce moved)", async () => {
    const ok = keeper([healthy, healthy]);
    expect(await ok.k.ensure()).toBe(false);
    expect(await ok.k.ensureIfStale()).toBe(false); // cached, no read
    ok.k.invalidate();
    expect(await ok.k.ensureIfStale()).toBe(false); // read, healthy, no open

    const dead = keeper([{ ...healthy, live: false }, healthy]);
    expect(await dead.k.ensureIfStale()).toBe(true);
    expect(dead.open).toHaveBeenCalledTimes(1);
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
    const bad = keeper([low, ...Array(STATUS_POLLS).fill(low), healthy]);
    await expect(bad.k.ensure()).rejects.toThrow(/not usable/);
    await bad.k.ensureIfStale();
    expect(bad.readStatus).toHaveBeenCalledTimes(2 + STATUS_POLLS);
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

describe("pollUntil", () => {
  it("returns the first value that passes, sleeping between reads", async () => {
    const read = vi.fn<() => Promise<number>>().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    const sleep = vi.fn(async () => {});
    expect(await pollUntil(read, (v) => v >= 2, { tries: 5, delayMs: 10, sleep })).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returns the last value after `tries` reads when none passes", async () => {
    const read = vi.fn(async () => 0);
    const sleep = vi.fn(async () => {});
    expect(await pollUntil(read, (v) => v > 0, { tries: 3, delayMs: 10, sleep })).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("skipWhileBusy", () => {
  it("drops a call while the previous one is still running, then runs again", async () => {
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((r) => (release = r)));
    const tick = skipWhileBusy(task);
    const first = tick();
    await tick(); // dropped: the first is still running
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await first;
    const third = tick();
    expect(task).toHaveBeenCalledTimes(2);
    release();
    await third;
  });

  it("is free again after a task fails", async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const tick = skipWhileBusy(task);
    await expect(tick()).rejects.toThrow("boom");
    await tick();
    expect(task).toHaveBeenCalledTimes(2);
  });
});

describe("createWindowKeeper.status (Task 6C /health)", () => {
  it("is undefined before any read, then the last status read; invalidate() does not clear it", async () => {
    const dead = { ...healthy, live: false };
    const { k } = keeper([dead, healthy]);
    expect(k.status()).toBeUndefined();
    await k.ensure(); // reads dead, opens, reads healthy
    expect(k.status()).toEqual(healthy);
    k.invalidate();
    expect(k.status()).toEqual(healthy);
  });
});

describe("guardianBlocksFor", () => {
  it("is remaining + 200, capped at 14400", () => {
    expect(guardianBlocksFor(600n)).toBe(800);
    expect(guardianBlocksFor(14_400n)).toBe(14_400);
    expect(guardianBlocksFor(1_000_000n)).toBe(14_400);
  });
  it("buildGuardianWindowParams forwards a custom block count", () => {
    expect(buildGuardianWindowParams("qor1g", VAULT, 800).blocks).toBe(800);
  });
});

describe("createOnDemandWatcher", () => {
  function setup(owner: { live: boolean; remainingBlocks: bigint }) {
    let usable = false;
    const ensure = vi.fn(async (_o?: { blocks?: number }) => {
      if (usable) return false;
      usable = true;
      return true;
    });
    const keeper = { ensure, lastOpen: () => "ARMHASH" };
    const alert = vi.fn();
    const log = vi.fn();
    let t = 1_000_000;
    const w = createOnDemandWatcher({ readOwnerWindow: async () => owner, keeper, alert, log, now: () => t });
    return { w, ensure, alert, advance: (ms: number) => (t += ms) };
  }

  it("idle owner: no window is opened", async () => {
    const { w, ensure, alert } = setup({ live: false, remainingBlocks: 0n });
    for (let i = 0; i < 3; i++) await w.tick();
    expect(ensure).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("owner window live, guardian none: opens once with blocks = remaining + 200", async () => {
    const { w, ensure, alert } = setup({ live: true, remainingBlocks: 600n });
    await w.tick();
    await w.tick();
    expect(ensure.mock.calls.filter(([o]) => o?.blocks === 800)).toHaveLength(2); // second call finds it usable
    expect(ensure.mock.results.length).toBe(2);
    expect(await ensure.mock.results[0].value).toBe(true);
    expect(await ensure.mock.results[1].value).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith("owner window opened outside the app; guardian window opened");
  });

  it("arm opens before the owner window and suppresses the alert", async () => {
    const { w, ensure, alert, advance } = setup({ live: true, remainingBlocks: 600n });
    expect(await w.arm(600)).toBe("ARMHASH");
    expect(ensure).toHaveBeenCalledWith({ blocks: 600 });
    advance(5_000);
    await w.tick();
    expect(alert).not.toHaveBeenCalled();
  });

  it("arm resolves null when the guardian window was already usable", async () => {
    const { w } = setup({ live: false, remainingBlocks: 0n });
    await w.arm(600);
    expect(await w.arm(600)).toBeNull();
  });
});
