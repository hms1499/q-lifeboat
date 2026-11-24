import { describe, expect, it } from "vitest";
import { DRILL_STAGES, parseDrillRuns, parseDrillState, stageStatus, type DrillState } from "./drill";

const base: DrillState = { status: "idle", runId: null, stage: null, startedAt: null, endedAt: null, error: null, lines: [] };
const run = {
  runId: "r1", mode: "drill", pass: true, failures: [], firstDrainBlock: "10", blocks: "2", keptPct: "100.00",
  incident: "abc", owner: "0x1", vault: "0x2", checkedAt: "2026-11-24T00:00:00Z",
};

describe("stageStatus", () => {
  it("test_stageStatusRunning", () => {
    const s: DrillState = { ...base, status: "running", stage: "attack" };
    expect(DRILL_STAGES.map((g) => stageStatus(s, g))).toEqual(["done", "done", "done", "active", "pending", "pending", "pending"]);
  });
  it("test_stageStatusFailMarksCurrentStageFailed", () => {
    const s: DrillState = { ...base, status: "fail", stage: "incident", error: "x" };
    expect(DRILL_STAGES.map((g) => stageStatus(s, g))).toEqual(["done", "done", "done", "done", "failed", "pending", "pending"]);
  });
  it("test_stageStatusPassAllDone", () => {
    const s: DrillState = { ...base, status: "pass", stage: "verdict" };
    expect(DRILL_STAGES.every((g) => stageStatus(s, g) === "done")).toBe(true);
  });
  it("idle and unknown stage are all pending", () => {
    expect(DRILL_STAGES.every((g) => stageStatus(base, g) === "pending")).toBe(true);
  });
});

describe("parseDrillState", () => {
  it("test_parseDrillStateRejectsBadShape", () => {
    expect(parseDrillState({ ...base, lines: ["a"] })).toEqual({ ...base, lines: ["a"] });
    expect(() => parseDrillState(null)).toThrow();
    expect(() => parseDrillState({ ...base, status: "weird" })).toThrow();
    expect(() => parseDrillState({ ...base, stage: "nope" })).toThrow();
    expect(() => parseDrillState({ ...base, lines: [1] })).toThrow();
    expect(() => parseDrillState({ ...base, runId: 5 })).toThrow();
  });
});

describe("parseDrillRuns", () => {
  it("test_parseDrillRunsDropsMalformedRows", () => {
    const out = parseDrillRuns([run, { ...run, pass: "yes" }, null, { ...run, runId: "r2", blocks: null }]);
    expect(out.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(parseDrillRuns("nope")).toEqual([]);
  });
});
