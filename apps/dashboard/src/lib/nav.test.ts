import { describe, expect, it } from "vitest";
import { navGroups, navMode } from "./nav";

const ids = () => navGroups().flatMap((g) => g.items.map((i) => i.id));

describe("nav", () => {
  it("the legacy sidebar is local mode's (the builder's own agent): Protect and Fire drill stay; no in-app wallet screens", () => {
    expect(ids()).toEqual(["overview", "incidents", "recover", "protect", "rules", "drill"]);
    expect(ids()).not.toContain("attack");
    expect(ids()).not.toContain("start");
  });

  it("mode: hosted for an in-app wallet, and for a visitor with no local agent; local only with a local agent and no wallet", () => {
    expect(navMode({ hasSeed: true, localAgent: true })).toBe("hosted");
    expect(navMode({ hasSeed: false, localAgent: false })).toBe("visitor");
    expect(navMode({ hasSeed: undefined, localAgent: false })).toBe("hosted");
    expect(navMode({ hasSeed: false, localAgent: true })).toBe("local");
    expect(navMode({ hasSeed: false, localAgent: true, hostedBuild: true })).toBe("visitor");
    expect(navMode({ hasSeed: undefined, localAgent: false, hostedBuild: true })).toBe("hosted");
  });
});
