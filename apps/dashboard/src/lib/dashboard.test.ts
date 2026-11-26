import type { Incident } from "@qday/core";
import { describe, expect, it } from "vitest";
import { heroState, testPlan } from "./dashboard";

const inc = { id: "i1" } as unknown as Incident;
const E18 = 10n ** 18n;

describe("heroState", () => {
  it("an unseen incident wins; otherwise calm while the Guardian answers, offline when it does not", () => {
    expect(heroState({ unseen: inc, agentOnline: true })).toBe("incident");
    expect(heroState({ unseen: inc, agentOnline: false })).toBe("incident");
    expect(heroState({ unseen: null, agentOnline: true })).toBe("calm");
    expect(heroState({ unseen: null, agentOnline: false })).toBe("offline");
  });
});

describe("testPlan", () => {
  it("runs straight away with 20 fUSD or more, mints 100 fUSD first below that, waits while reading", () => {
    expect(testPlan(undefined)).toBe("loading");
    expect(testPlan(0n)).toBe("mint-first");
    expect(testPlan(19n * E18)).toBe("mint-first");
    expect(testPlan(20n * E18)).toBe("ready");
  });
});
