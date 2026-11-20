import type { Incident, OutboundTx, RescueRecord } from "@qday/core";
import { describe, expect, it, vi } from "vitest";
import { createGuardian } from "../src/guardian";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const STRANGER = "0x9999999999999999999999999999999999999999" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const policy = { vault: VAULT, allowlist: [], maxOutbound: 100n };
const tx = (hash: string, to: `0x${string}` = STRANGER): OutboundTx => ({ hash: hash as `0x${string}`, block: 1n, token: ZERO, to, amount: 5n });
const rec = (success = true): RescueRecord => ({ token: "0x00000000000000000000000000000000000000a1", hash: "H", amount: 1n, success });

function setup(rescue: () => Promise<RescueRecord[]>) {
  const record = vi.fn(async (f: { trigger: OutboundTx; reason: string; rescues: RescueRecord[] }) => ({ ...f, id: "x" }) as unknown as Incident);
  const publish = vi.fn();
  const g = createGuardian({ policy, rescue: vi.fn(rescue), record, publish, log: () => {} });
  return { g, record, publish };
}

describe("guardian", () => {
  it("does nothing for a transfer decide() allows", async () => {
    const { g, record } = setup(async () => [rec()]);
    await g.onTx(tx("0x1", VAULT));
    expect(record).not.toHaveBeenCalled();
  });

  it("rescues, records and publishes an incident for a bad transfer", async () => {
    const { g, record, publish } = setup(async () => [rec()]);
    await g.onTx(tx("0x1"));
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0].rescues).toHaveLength(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("is single-flight: a trigger during a rescue causes exactly one recheck", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { g, record } = setup(async () => {
      calls++;
      if (calls === 1) await gate;
      return calls === 1 ? [rec()] : [];
    });
    const first = g.onTx(tx("0x1"));
    await Promise.resolve();
    await g.onTx(tx("0x2")); // arrives while in flight: returns immediately
    await g.onTx(tx("0x3"));
    expect(calls).toBe(1);
    release();
    await first;
    expect(calls).toBe(2); // one recheck for both queued triggers
    expect(record).toHaveBeenCalledOnce(); // the empty recheck is a no-op, not an incident
  });

  it("records an incident even when the first rescue finds nothing to move", async () => {
    const { g, record } = setup(async () => []);
    await g.onTx(tx("0x1"));
    expect(record).toHaveBeenCalledOnce();
  });

  it("records a rescue error instead of throwing", async () => {
    const { g, record } = setup(async () => { throw new Error("rpc down"); });
    await g.onTx(tx("0x1"));
    expect(record.mock.calls[0][0].reason).toMatch(/rpc down/);
    // and the guard is released
    await g.onTx(tx("0x2"));
    expect(record).toHaveBeenCalledTimes(2);
  });
});
