import type { Incident, OutboundTx, RescueRecord } from "@qday/core";
import { describe, expect, it, vi } from "vitest";
import { createGuardian } from "../src/guardian";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const STRANGER = "0x9999999999999999999999999999999999999999" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const policy = { vault: VAULT, allowlist: [], maxOutbound: 100n };
const tx = (hash: string, to: `0x${string}` = STRANGER): OutboundTx => ({ kind: "transfer", hash: hash as `0x${string}`, block: 1n, token: ZERO, to, amount: 5n });
/** Approval(owner, vault, 0): the owner key revoked the vault's allowance (decide: alert only). */
const revoke = (hash: string): OutboundTx => ({ kind: "approval", hash: hash as `0x${string}`, block: 1n, token: "0x00000000000000000000000000000000000000a1", to: VAULT, amount: 0n });
const rec = (success = true): RescueRecord => ({ token: "0x00000000000000000000000000000000000000a1", hash: "H", amount: 1n, expected: 1n, success });

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

  it("stamps detectedAt when the trigger is seen, before rescue runs", async () => {
    const { g, record } = setup(async () => [rec()]);
    const before = Date.now();
    await g.onTx(tx("0x1"));
    const at = (record.mock.calls[0][0] as unknown as { detectedAt: string }).detectedAt;
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before);
  });

  it("a failing record() does not leak a stale queued trigger into the next run", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rescue = vi.fn(async () => { calls++; if (calls === 1) await gate; return calls === 2 ? [] : [rec()]; });
    const record = vi.fn(async () => { throw new Error("disk full"); });
    const g = createGuardian({ policy, rescue, record: record as never, publish: vi.fn(), log: () => {} });
    const first = g.onTx(tx("0x1"));
    await Promise.resolve();
    await g.onTx(tx("0x2")); // queued
    release();
    await first; // must not throw
    expect(rescue).toHaveBeenCalledTimes(2); // first + the one queued recheck
    await g.onTx(tx("0x3"));
    expect(rescue).toHaveBeenCalledTimes(3); // exactly one new run, no stale replay
  });

  it("passes the trigger to rescue (so its token goes first), and the queued trigger to the recheck", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rescue = vi.fn(async (_t: OutboundTx) => { if (rescue.mock.calls.length === 1) await gate; return [rec()]; });
    const record = vi.fn(async (f: { trigger: OutboundTx }) => ({ ...f, id: "x" }) as unknown as Incident);
    const g = createGuardian({ policy, rescue, record: record as never, publish: vi.fn(), log: () => {} });
    const first = g.onTx(tx("0x1"));
    await Promise.resolve();
    await g.onTx(tx("0x2"));
    release();
    await first;
    expect(rescue.mock.calls.map(([t]) => t.hash)).toEqual(["0x1", "0x2"]);
  });

  it("logs the trigger block and the detection time of every rescue decision", async () => {
    const lines: string[] = [];
    const g = createGuardian({ policy, rescue: async () => [rec()], record: (async (f: object) => ({ ...f, id: "x" })) as never, publish: vi.fn(), log: (l) => void lines.push(l) });
    await g.onTx({ ...tx("0x1"), block: 42n });
    const timing = lines.find((l) => l.startsWith("timing: trigger"));
    expect(timing).toMatch(/^timing: trigger 0x1 block 42 detected \d{4}-\d{2}-\d{2}T/);
  });

  it("records a rescue error instead of throwing", async () => {
    const { g, record } = setup(async () => { throw new Error("rpc down"); });
    await g.onTx(tx("0x1"));
    expect(record.mock.calls[0][0].reason).toMatch(/rpc down/);
    // and the guard is released
    await g.onTx(tx("0x2"));
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("an alert-only trigger records and publishes exactly one incident with no rescues, and never calls rescue", async () => {
    const rescue = vi.fn(async () => [rec()]);
    const record = vi.fn(async (f: { trigger: OutboundTx; reason: string; rescues: RescueRecord[] }) => ({ ...f, id: "x" }) as unknown as Incident);
    const publish = vi.fn();
    const g = createGuardian({ policy, rescue, record, publish, log: () => {} });
    await g.onTx(revoke("0xa"));
    expect(rescue).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({ trigger: revoke("0xa"), rescues: [], alert: true, reason: expect.stringMatching(/revoked the vault allowance/) });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("an alert during a rescue in flight is recorded at once and neither waits for, queues nor triggers a rescue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rescue = vi.fn(async () => { await gate; return [rec()]; });
    const record = vi.fn(async (f: { trigger: OutboundTx; reason: string; rescues: RescueRecord[] }) => ({ ...f, id: "x" }) as unknown as Incident);
    const g = createGuardian({ policy, rescue, record, publish: vi.fn(), log: () => {} });
    const first = g.onTx(tx("0x1"));
    await Promise.resolve();
    await g.onTx(revoke("0xa")); // resolves while the rescue is still blocked
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0].trigger.hash).toBe("0xa");
    expect(record.mock.calls[0][0].rescues).toEqual([]);
    release();
    await first;
    expect(rescue).toHaveBeenCalledOnce(); // the alert queued no recheck
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1][0].trigger.hash).toBe("0x1");
    // and the single-flight guard was released normally
    await g.onTx(tx("0x2"));
    expect(rescue).toHaveBeenCalledTimes(2);
  });

  it("a failing record() for an alert is logged, never thrown", async () => {
    const lines: string[] = [];
    const rescue = vi.fn(async () => [rec()]);
    const g = createGuardian({ policy, rescue, record: (async () => { throw new Error("disk full"); }) as never, publish: vi.fn(), log: (l) => void lines.push(l) });
    await expect(g.onTx(revoke("0xa"))).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("disk full"))).toBe(true);
    expect(rescue).not.toHaveBeenCalled();
  });
});
