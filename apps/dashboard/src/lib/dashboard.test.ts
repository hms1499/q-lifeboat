import type { Incident } from "@qday/core";
import { describe, expect, it } from "vitest";
import { heroState, testPlan } from "./dashboard";

const inc = { id: "i1" } as unknown as Incident;
const E18 = 10n ** 18n;

const ok = { unseen: null, agentOnline: true, agentChecked: true, checkFailed: false, healthOk: true, paused: false };

describe("heroState", () => {
  it("an unseen incident wins; otherwise calm while the Guardian answers, offline when it does not", () => {
    expect(heroState({ ...ok, unseen: inc })).toBe("incident");
    expect(heroState({ ...ok, unseen: inc, agentOnline: false })).toBe("incident");
    expect(heroState({ ...ok, unseen: inc, checkFailed: true })).toBe("incident");
    expect(heroState(ok)).toBe("calm");
    expect(heroState({ ...ok, agentOnline: false })).toBe("offline");
  });

  it("never calm when the vault check failed or the Guardian reports itself unhealthy", () => {
    expect(heroState({ ...ok, checkFailed: true })).toBe("check");
    expect(heroState({ ...ok, checkFailed: true, agentOnline: false })).toBe("check");
    expect(heroState({ ...ok, healthOk: false })).toBe("degraded");
    // No /health answer yet is not a failure.
    expect(heroState({ ...ok, healthOk: undefined })).toBe("calm");
  });

  it("a Guardian retired for idleness is paused, not offline; before the first answer it is loading, not offline", () => {
    expect(heroState({ ...ok, paused: true, agentOnline: false })).toBe("paused");
    expect(heroState({ ...ok, agentOnline: false, agentChecked: false })).toBe("loading");
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
