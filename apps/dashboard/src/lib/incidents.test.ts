import { describe, expect, it } from "vitest";
import { incidentTag, mergeIncident, partitionByOwner, parseIncidentList, sortIncidents, triggerKind } from "./incidents";

const inc = (id: string, detectedAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, detectedAt, trigger: { kind: "transfer" }, rescues: [], ...extra }) as never;

/** A well-formed incident as the agent serves it (bigints as decimal strings). */
const full = () => ({
  id: "ok-1",
  detectedAt: "2026-11-21T10:00:00.000Z",
  trigger: { kind: "transfer", hash: `0x${"cc".repeat(32)}`, block: "100", token: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", amount: "10" },
  reason: "r",
  rescues: [{ token: "0x1111111111111111111111111111111111111111", hash: `0x${"aa".repeat(32)}`, amount: "90", expected: "90", success: true }],
  summary: "s",
  summarySource: "template",
  agentPubkey: "ab".repeat(32),
  sig: "cd".repeat(64),
});

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
    // a new body under a known id replaces the old one (it is then verified afresh)
    const replaced = mergeIncident(one, { ...(inc("b", "2026-11-21T10:00:09.000Z") as object), sig: "new" } as never);
    expect(replaced.find((i: { id: string }) => i.id === "b")).toMatchObject({ sig: "new" });
    expect(one.map((i: { id: string }) => i.id)).toEqual(["b", "a"]);
    expect(mergeIncident(one, inc("b", "2026-11-21T10:00:09.000Z"))).toHaveLength(2);
  });

  it("keeps only well-formed incidents from the /incidents body", () => {
    expect(parseIncidentList([full(), null, 5, { id: 3 }, { nope: 1 }]).map((i: { id: string }) => i.id)).toEqual(["ok-1"]);
    expect(parseIncidentList({ not: "an array" })).toEqual([]);
  });

  it("test_dropsMalformedIncidents: anything the screens would crash on is dropped, a valid old (no kind) one is kept", () => {
    const good = full();
    const { kind: _k, ...oldTrigger } = good.trigger;
    expect(parseIncidentList([{ ...good, trigger: oldTrigger }])).toHaveLength(1);
    const bad = [
      { ...good, rescues: "x" },
      { ...good, rescues: [{ ...good.rescues[0], token: 5 }] },
      { ...good, rescues: [{ ...good.rescues[0], success: "yes" }] },
      { ...good, rescues: [{ ...good.rescues[0], amount: 90 }] },
      { ...good, rescues: [null] },
      { ...good, trigger: null },
      { ...good, trigger: { ...good.trigger, token: undefined } },
      { ...good, trigger: { ...good.trigger, to: "nope" } },
      { ...good, trigger: { ...good.trigger, amount: "1e18" } },
      { ...good, trigger: { ...good.trigger, kind: "mint" } },
      { ...good, detectedAt: 7 },
      { ...good, summary: null },
      { ...good, sig: 1 },
      { ...good, agentPubkey: undefined },
    ];
    for (const b of bad) expect(parseIncidentList([b]), JSON.stringify(b).slice(0, 80)).toEqual([]);
  });
});

describe("partitionByOwner", () => {
  const OWNER = "0xAbCdEf0000000000000000000000000000000001";
  const h = (n: number) => `0x${String(n).repeat(64)}`;
  const t = (id: string, n: number) => ({ id, trigger: { hash: h(n).toUpperCase().replace("0X", "0x") } }) as never;
  const list = [t("a", 1), t("b", 2), t("c", 3), t("d", 4)];
  it("splits by sender, case-insensitive, keeping order", () => {
    const r = partitionByOwner(
      list,
      { [h(1)]: OWNER.toLowerCase(), [h(2)]: "0x0000000000000000000000000000000000000009", [h(3)]: null },
      OWNER,
    );
    expect(r.mine.map((i) => i.id)).toEqual(["a"]);
    expect(r.others.map((i) => i.id)).toEqual(["b"]);
    expect(r.checking.map((i) => i.id)).toEqual(["c", "d"]);
  });
  it("keeps order within a bucket", () => {
    const r = partitionByOwner(list, { [h(1)]: OWNER, [h(2)]: OWNER, [h(3)]: OWNER, [h(4)]: OWNER.toUpperCase() }, OWNER);
    expect(r.mine.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
});
