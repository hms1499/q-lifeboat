import { describe, expect, it, vi } from "vitest";
import { createHealth, DEFAULT_GAS_LOW_WEI } from "../src/health";
import type { AlertEvent } from "../src/notify";
import type { WindowStatus } from "../src/window";

const GUARDIAN = "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94" as const;
const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const QOR = 10n ** 18n;
/** Usable for needsWindow: live, scoped to VAULT, >= 100 blocks, >= 3 txs, budget for 3 rescue txs (1 QOR is plenty). */
const live: WindowStatus = { live: true, remainingBlocks: 500n, remainingTxs: 8n, remainingValue: QOR, allowedTargets: [VAULT] };

function setup(balances: (bigint | Error)[], window: WindowStatus | null = live) {
  const queue = [...balances];
  let t = Date.parse("2026-11-21T10:00:00.000Z");
  const notify = vi.fn((_e: AlertEvent) => {});
  const lines: string[] = [];
  const h = createHealth({
    guardian: GUARDIAN,
    vault: VAULT,
    gasLowWei: QOR / 2n,
    readBalance: async () => {
      const b = queue.shift();
      if (b === undefined) throw new Error("no more balances");
      if (b instanceof Error) throw b;
      return b;
    },
    readWindow: () => window ?? undefined,
    channels: { telegram: true, webhook: false },
    notify,
    log: (l) => void lines.push(l),
    now: () => new Date(t),
    startedAt: "2026-11-21T09:59:00.000Z",
  });
  return { h, notify, lines, advance: (ms: number) => void (t += ms) };
}

describe("health", () => {
  it("defaults the gas threshold to 0.5 QOR", () => {
    expect(DEFAULT_GAS_LOW_WEI).toBe(5n * 10n ** 17n);
  });

  it("test_gasLowAlertFiresOnceBelowThreshold", async () => {
    const { h, notify } = setup([QOR, QOR / 4n, QOR / 5n, QOR / 2n, QOR / 3n]);
    await h.checkGas(); // 1 QOR: fine
    expect(notify).not.toHaveBeenCalled();
    await h.checkGas(); // 0.25: low -> one alert
    await h.checkGas(); // 0.2: still low -> no second alert
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toEqual({ type: "gas-low", guardian: GUARDIAN, balance: QOR / 4n, threshold: QOR / 2n });
    await h.checkGas(); // 0.5: at the threshold -> recovered, the mark clears
    expect(notify).toHaveBeenCalledOnce();
    await h.checkGas(); // 0.33: low again -> fires again
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("checkGas never throws: a read error is logged and the last value kept; a throwing notify is caught", async () => {
    const { h, lines } = setup([QOR, new Error("rpc down")]);
    await h.checkGas();
    await expect(h.checkGas()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("rpc down"))).toBe(true);
    expect(h.snapshot().gas.balance).toBe(QOR);

    const bad = createHealth({
      guardian: GUARDIAN, vault: VAULT, gasLowWei: QOR, readBalance: async () => 1n, readWindow: () => live,
      channels: { telegram: false, webhook: false }, notify: () => { throw new Error("boom"); }, log: () => {}, startedAt: "s",
    });
    await expect(bad.checkGas()).resolves.toBeUndefined();
  });

  it("snapshot: ok needs a recent tip, a live window and a known balance that is not low", async () => {
    const { h, advance } = setup([QOR, QOR / 10n]);
    expect(h.snapshot()).toEqual({
      ok: false,
      startedAt: "2026-11-21T09:59:00.000Z",
      lastBlock: null,
      lastBlockAt: null,
      window: { live: true, remainingBlocks: 500n, remainingTxs: 8n, remainingValue: QOR },
      gas: { guardian: GUARDIAN, balance: null, threshold: QOR / 2n, low: false },
      alerts: { telegram: true, webhook: false },
      recentAlerts: [],
    });
    h.setTip(7n);
    expect(h.snapshot().ok).toBe(false); // balance unknown
    await h.checkGas();
    expect(h.snapshot()).toMatchObject({ ok: true, lastBlock: 7n, lastBlockAt: "2026-11-21T10:00:00.000Z", gas: { balance: QOR, low: false } });
    advance(31_000);
    expect(h.snapshot().ok).toBe(false); // tip is stale
    h.setTip(8n);
    expect(h.snapshot().ok).toBe(true);
    await h.checkGas();
    expect(h.snapshot()).toMatchObject({ ok: false, gas: { low: true } });
  });

  it("snapshot: no or dead window is not ok", async () => {
    const none = setup([QOR], null);
    none.h.setTip(1n);
    await none.h.checkGas();
    expect(none.h.snapshot()).toMatchObject({ ok: false, window: null });
    const dead = setup([QOR], { ...live, live: false });
    dead.h.setTip(1n);
    await dead.h.checkGas();
    expect(dead.h.snapshot()).toMatchObject({ ok: false, window: { live: false } });
  });

  it("snapshot: a live window the keeper considers unusable (needsWindow) is not ok", async () => {
    const OTHER_VAULT = "0x776913Abe058941d4c8ac097EE47E29F528f71e6" as const;
    for (const w of [{ ...live, allowedTargets: [OTHER_VAULT] }, { ...live, remainingTxs: 2n }, { ...live, remainingBlocks: 99n }]) {
      const s = setup([QOR], w);
      s.h.setTip(1n);
      await s.h.checkGas();
      expect(s.h.snapshot()).toMatchObject({ ok: false, window: { live: true } });
    }
  });
});

describe("recent alerts", () => {
  it("recordAlert shows up in the snapshot, newest first, capped at 10", () => {
    const { h, advance } = setup([QOR]);
    for (let i = 0; i < 12; i++) {
      advance(1_000);
      h.recordAlert(`m${i}`);
    }
    const r = h.snapshot().recentAlerts;
    expect(r).toHaveLength(10);
    expect(r[0]).toEqual({ at: Date.parse("2026-11-21T10:00:12.000Z") / 1000, message: "m11" });
    expect(r[9].message).toBe("m2");
  });
});
