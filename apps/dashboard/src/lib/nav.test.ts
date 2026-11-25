import { describe, expect, it } from "vitest";
import { navGroups, navMode } from "./nav";

const ids = (m: "hosted" | "local") => navGroups(m).flatMap((g) => g.items.map((i) => i.id));

describe("nav", () => {
  it("hosted: no Protect (MetaMask) and no Fire drill; Get protected, Try an attack and Rules are there", () => {
    expect(ids("hosted")).not.toContain("protect");
    expect(ids("hosted")).not.toContain("drill");
    expect(ids("hosted")).toEqual(expect.arrayContaining(["start", "overview", "incidents", "recover", "attack", "rules"]));
  });

  it("local (the builder's own agent): Protect and Fire drill stay; no in-app wallet screens", () => {
    expect(ids("local")).toEqual(expect.arrayContaining(["overview", "incidents", "recover", "protect", "rules", "drill"]));
    expect(ids("local")).not.toContain("attack");
    expect(ids("local")).not.toContain("start");
  });

  it("mode: hosted for an in-app wallet, and for a visitor with no local agent; local only with a local agent and no wallet", () => {
    expect(navMode({ hasSeed: true, localAgent: true })).toBe("hosted");
    expect(navMode({ hasSeed: false, localAgent: false })).toBe("hosted");
    expect(navMode({ hasSeed: undefined, localAgent: false })).toBe("hosted");
    expect(navMode({ hasSeed: false, localAgent: true })).toBe("local");
  });
});
