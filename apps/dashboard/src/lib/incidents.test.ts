import { describe, expect, it } from "vitest";
import { incidentTag, mergeIncident, parseIncidentList, sortIncidents, triggerKind } from "./incidents";

const inc = (id: string, detectedAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, detectedAt, trigger: { kind: "transfer" }, rescues: [], ...extra }) as never;

describe("sortIncidents", () => {
  it("sorts by detectedAt, newest first, whatever the file order (6C appends out of order)", () => {
    const list = [inc("b", "2026-11-21T10:00:01.000Z"), inc("c", "2026-11-21T09:59:59.000Z"), inc("a", "2026-11-21T10:00:05.000Z")];
    expect(sortIncidents(list).map((i: { id: string }) => i.id)).toEqual(["a", "b", "c"]);
    expect(list.map((i: { id: string }) => i.id)).toEqual(["b", "c", "a"]); // input untouched
  });

  it("puts an unparsable detectedAt last", () => {
    expect(sortIncidents([inc("x", "garbage"), inc("y", "2026-11-21T10:00:00.000Z")]).map((i: { id: string }) => i.id)).toEqual(["y", "x"]);
  });
});

describe("triggerKind / incidentTag", () => {
  it("a trigger with no kind is a transfer (incidents before 6B)", () => {
    expect(triggerKind(inc("a", "t", { trigger: {} }))).toBe("transfer");
    expect(triggerKind(inc("a", "t", { trigger: { kind: "approval" } }))).toBe("approval");
  });

  it("does not add kind to the incident (that would break its signature)", () => {
    const i = inc("a", "t", { trigger: {} }) as { trigger: Record<string, unknown> };
    triggerKind(i as never);
    expect("kind" in i.trigger).toBe(false);
  });

  it("tags Rescue when there were rescue attempts, Alert otherwise", () => {
    expect(incidentTag(inc("a", "t", { rescues: [{ success: false }] }))).toBe("Rescue");
    expect(incidentTag(inc("a", "t", { rescues: [] }))).toBe("Alert");
  });
});

describe("mergeIncident / parseIncidentList", () => {
  it("adds a live incident once (SSE replay or reconnect never duplicates)", () => {
    const list = [inc("a", "2026-11-21T10:00:00.000Z")];
    const one = mergeIncident(list, inc("b", "2026-11-21T10:00:09.000Z"));
    expect(one.map((i: { id: string }) => i.id)).toEqual(["b", "a"]);
    expect(mergeIncident(one, inc("b", "2026-11-21T10:00:09.000Z"))).toHaveLength(2);
  });

  it("keeps only objects with a string id from the /incidents body", () => {
    expect(parseIncidentList([inc("a", "t"), null, 5, { id: 3 }, { nope: 1 }]).map((i: { id: string }) => i.id)).toEqual(["a"]);
    expect(parseIncidentList({ not: "an array" })).toEqual([]);
  });
});
