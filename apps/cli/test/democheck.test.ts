import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  drainsWithoutBlock,
  evaluateRun,
  parseAttackFile,
  pickIncident,
  rescueHashes,
  waitForIncident,
  type AttackFile,
  type IncidentView,
} from "../src/democheck";

const E18 = 10n ** 18n;
const D1 = `0x${"d1".repeat(32)}` as Hex;
const D2 = `0x${"d2".repeat(32)}` as Hex;
const R1 = `0x${"a1".repeat(32)}` as Hex;

const attackFile = (over: Partial<AttackFile> = {}): AttackFile => ({
  drains: [
    { index: 1, hash: D1, block: "1000", status: "success" },
    { index: 2, hash: D2, block: "1001", status: "success" },
    { index: 3, hash: `0x${"d3".repeat(32)}` as Hex, block: "1002", status: "reverted" },
  ],
  forged: { amount: "80", revert: "BadSignature", status: "reverted", pass: true },
  misuse: { reason: "x: authenticator not permitted for this action", executions: [], pass: true },
  ...over,
});

const incident = (
  triggerHash: string,
  detectedAt: string,
  rescues: IncidentView["rescues"] = [{ token: "0xf", hash: R1, amount: "80", expected: "80", success: true }],
): IncidentView => ({
  id: detectedAt,
  detectedAt,
  trigger: { hash: triggerHash },
  rescues,
});

describe("parseAttackFile", () => {
  it("reads attack.json and refuses a file without drains", () => {
    expect(parseAttackFile(JSON.stringify(attackFile())).drains).toHaveLength(3);
    expect(() => parseAttackFile("{}")).toThrow(/drains/);
    expect(() => parseAttackFile("nope")).toThrow(/JSON/);
  });
});

describe("pickIncident", () => {
  it("picks the newest incident whose trigger is one of the drains (any case)", () => {
    const list = [
      incident("0xother", "2026-11-20T10:00:03Z"),
      incident(D1.toUpperCase().replace("0X", "0x"), "2026-11-20T10:00:01Z"),
      incident(D2, "2026-11-20T10:00:02Z"),
    ];
    expect(pickIncident(list, [D1, D2])?.id).toBe("2026-11-20T10:00:02Z");
    expect(pickIncident(list, ["0xnone"])).toBeUndefined();
    expect(pickIncident([], [D1])).toBeUndefined();
  });
});

describe("rescueHashes", () => {
  it("lists the hashes of the incident's successful rescues", () => {
    const inc = incident(D1, "t", [
      { token: "0xa", hash: R1, amount: "1", expected: "1", success: true },
      { token: "0xb", hash: "", amount: "0", expected: "1", success: false },
      { token: "0xc", hash: "0xdead", amount: "0", expected: "1", success: false },
    ]);
    expect(rescueHashes(inc)).toEqual([R1]);
  });
});

describe("evaluateRun", () => {
  const ok = { attack: attackFile(), incident: incident(D1, "t"), rescueBlock: 1002n, vaultFusd: 79n * E18, recoveredFusd: 1n * E18, attackerFusd: 20n * E18 };

  it("passes with blocks <= 3, kept >= 80% (vault + recovered), (a) and (b) passed", () => {
    const r = evaluateRun(ok);
    expect(r.pass).toBe(true);
    expect(r.firstDrainBlock).toBe(1000n);
    expect(r.blocks).toBe(2n);
    expect(r.keptPct).toBe("80.00");
    expect(r.failures).toEqual([]);
    const text = r.lines.join("\n");
    expect(text).toMatch(/first drain block\s+1000/);
    expect(text).toMatch(/rescue block\s+1002/);
    expect(text).toMatch(/attacker fUSD\s+20/);
  });

  it("passes at exactly 3 blocks, fails at 4", () => {
    expect(evaluateRun({ ...ok, rescueBlock: 1003n }).pass).toBe(true);
    const r = evaluateRun({ ...ok, rescueBlock: 1004n });
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/4 blocks/);
  });

  it("fails below 80% kept", () => {
    const r = evaluateRun({ ...ok, vaultFusd: 79n * E18, recoveredFusd: 0n });
    expect(r.keptPct).toBe("79.00");
    expect(r.failures.join()).toMatch(/kept/);
  });

  it("fails when (a) or (b) failed", () => {
    expect(evaluateRun({ ...ok, attack: attackFile({ forged: { amount: "1", revert: "KeyNotProven", status: "reverted", pass: false } }) }).failures.join()).toMatch(/\(a\)/);
    expect(evaluateRun({ ...ok, attack: attackFile({ misuse: { reason: "", executions: [], pass: false, error: "x" } }) }).failures.join()).toMatch(/\(b\)/);
  });

  it("fails without an incident or a rescue block", () => {
    expect(evaluateRun({ ...ok, incident: undefined, rescueBlock: undefined }).failures.join()).toMatch(/no incident/);
    expect(evaluateRun({ ...ok, rescueBlock: undefined }).failures.join()).toMatch(/no successful rescue/);
  });

  it("uses the first SUCCESSFUL drain as the start, and fails when no drain landed", () => {
    const drains = [
      { index: 1, error: "window exhausted" },
      { index: 2, hash: D2, block: "1001", status: "success" as const },
    ];
    expect(evaluateRun({ ...ok, attack: attackFile({ drains }) }).firstDrainBlock).toBe(1001n);
    const none = evaluateRun({ ...ok, attack: attackFile({ drains: [{ index: 1, error: "refused" }] }) });
    expect(none.pass).toBe(false);
    expect(none.failures.join()).toMatch(/no drain landed/);
  });
});

describe("first drain block B", () => {
  // Drain 1 landed but its receipt wait failed: attack.json has its hash, no block.
  const lostReceipt = attackFile({
    drains: [
      { index: 1, hash: D1, error: "timeout" },
      { index: 2, hash: D2, block: "1001", status: "success" },
    ],
  });
  const base = { attack: lostReceipt, rescueBlock: 1004n, vaultFusd: 80n * E18, recoveredFusd: 0n, attackerFusd: 20n * E18 };

  it("lists drains that have a hash but no block, so their receipts can be fetched", () => {
    expect(drainsWithoutBlock(lostReceipt)).toEqual([D1]);
    expect(drainsWithoutBlock(attackFile())).toEqual([]);
  });

  it("is the min over recorded drain blocks, fetched receipt blocks of those drains, and the incident trigger's block", () => {
    // Without the extra sources B would be 1001 and the 4-block rescue would wrongly pass.
    expect(evaluateRun({ ...base, incident: incident(D2, "t") }).firstDrainBlock).toBe(1001n);
    const fetched = evaluateRun({ ...base, incident: incident(D2, "t"), drainReceiptBlocks: [1000n] });
    expect(fetched.firstDrainBlock).toBe(1000n);
    expect(fetched.pass).toBe(false);
    expect(fetched.failures.join()).toMatch(/4 blocks/);
    const fromTrigger = evaluateRun({ ...base, incident: { ...incident(D1, "t"), trigger: { hash: D1, block: "1000" } } });
    expect(fromTrigger.firstDrainBlock).toBe(1000n);
  });

  it("uses the trigger block when no drain block was recorded at all", () => {
    const r = evaluateRun({
      ...base,
      attack: attackFile({ drains: [{ index: 1, hash: D1, error: "timeout" }] }),
      incident: { ...incident(D1, "t"), trigger: { hash: D1, block: "1002" } },
    });
    expect(r.firstDrainBlock).toBe(1002n);
    expect(r.failures.join()).not.toMatch(/no drain landed/);
  });
});

describe("waitForIncident", () => {
  it("polls until an incident for the drains shows up", async () => {
    const fetchIncidents = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce([incident(D2, "t")]);
    const sleep = vi.fn(async () => {});
    const found = await waitForIncident({ fetchIncidents, hashes: [D1, D2], timeoutMs: 60_000, sleep, now: () => 0 });
    expect(found?.trigger.hash).toBe(D2);
    expect(fetchIncidents).toHaveBeenCalledTimes(3);
  });

  it("gives up after the timeout", async () => {
    let t = 0;
    const found = await waitForIncident({ fetchIncidents: async () => [], hashes: [D1], timeoutMs: 3_000, sleep: async (ms) => void (t += ms), now: () => t });
    expect(found).toBeUndefined();
  });
});
