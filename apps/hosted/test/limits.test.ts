import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createLimits, DAILY_CAP, FUNDER_FLOOR_UQOR, PER_IP_24H } from "../src/limits.ts";

const owner = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Hex;
const RICH = 100_000_000n;
const HOUR = 3600_000;

describe("starter-pack limits", () => {
  it("constants match the plan", () => {
    expect(PER_IP_24H).toBe(3);
    expect(DAILY_CAP).toBe(30);
    expect(FUNDER_FLOOR_UQOR).toBe(20_000_000n);
  });

  it("4th request from one IP within 24 h → ip-limit, allowed again after 24 h", () => {
    let t = Date.UTC(2026, 10, 25, 1);
    const l = createLimits(() => t);
    for (let i = 1; i <= 3; i++) {
      expect(l.check("1.2.3.4", owner(i), RICH)).toEqual({ ok: true });
      l.record("1.2.3.4", owner(i));
      t += HOUR;
    }
    expect(l.check("1.2.3.4", owner(4), RICH)).toEqual({ ok: false, reason: "ip-limit" });
    expect(l.check("5.6.7.8", owner(4), RICH)).toEqual({ ok: true });
    t += 22 * HOUR; // the first record is now older than 24 h
    expect(l.check("1.2.3.4", owner(4), RICH)).toEqual({ ok: true });
  });

  it("31st of the day → daily-cap, open again the next UTC day", () => {
    let t = Date.UTC(2026, 10, 25, 0, 5);
    const l = createLimits(() => t);
    for (let i = 1; i <= 30; i++) {
      const ip = `10.0.0.${i}`;
      expect(l.check(ip, owner(i), RICH)).toEqual({ ok: true });
      l.record(ip, owner(i));
    }
    expect(l.todayCount()).toBe(30);
    expect(l.check("10.0.1.1", owner(31), RICH)).toEqual({ ok: false, reason: "daily-cap" });
    t = Date.UTC(2026, 10, 26, 0, 1);
    expect(l.check("10.0.1.1", owner(31), RICH)).toEqual({ ok: true });
  });

  it("funder at 19.9 QOR → funder-low", () => {
    const l = createLimits(() => 0);
    expect(l.check("1.1.1.1", owner(1), 19_900_000n)).toEqual({ ok: false, reason: "funder-low" });
    expect(l.check("1.1.1.1", owner(1), 20_000_000n)).toEqual({ ok: true });
  });

  it("same owner twice → owner-used (case-insensitive), undo releases it", () => {
    const l = createLimits(() => 0);
    const a = ("0x" + "ab".repeat(20)) as Hex;
    l.record("1.1.1.1", a);
    expect(l.check("9.9.9.9", a.toUpperCase().replace("0X", "0x") as Hex, RICH)).toEqual({ ok: false, reason: "owner-used" });
    l.undo("1.1.1.1", a);
    expect(l.check("9.9.9.9", a, RICH)).toEqual({ ok: true });
    expect(l.check("1.1.1.1", owner(2), RICH)).toEqual({ ok: true });
  });

  it("seeded owners from the store stay used and count toward today's cap", () => {
    const t = Date.UTC(2026, 10, 25, 12);
    const l = createLimits(() => t, [{ owner: owner(1), at: t - HOUR }, { owner: owner(2), at: t - 48 * HOUR }]);
    expect(l.check("1.1.1.1", owner(1), RICH)).toEqual({ ok: false, reason: "owner-used" });
    expect(l.check("1.1.1.1", owner(2), RICH)).toEqual({ ok: false, reason: "owner-used" });
    expect(l.todayCount()).toBe(1);
  });
});
