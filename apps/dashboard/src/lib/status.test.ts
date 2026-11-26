import { describe, expect, it } from "vitest";
import { appStatus, guardianStatus, type StatusInput } from "./status";

const base: StatusInput = { mode: "hosted", hasCfg: true, checkFailed: false, agentOnline: true, healthOk: true };

describe("guardianStatus", () => {
  it("a visitor with no wallet has nothing set up, which is not an outage", () => {
    expect(guardianStatus({ ...base, mode: "visitor", hasCfg: false, agentOnline: false, healthOk: undefined })).toEqual({ dot: "off", text: "Not set up yet" });
  });

  it("a browser wallet whose Guardian does not exist yet is mid-setup", () => {
    expect(guardianStatus({ ...base, hasCfg: false, agentOnline: false, healthOk: undefined })).toEqual({ dot: "off", text: "Setup not finished" });
  });

  it("local mode with no agent config still says the Guardian is offline", () => {
    expect(guardianStatus({ ...base, mode: "local", hasCfg: false, agentOnline: false })).toEqual({ dot: "off", text: "Guardian offline" });
  });

  it("config served but the agent stopped answering: offline; a failed vault check wins; unhealthy is degraded", () => {
    expect(guardianStatus({ ...base, agentOnline: false })).toEqual({ dot: "off", text: "Guardian offline" });
    expect(guardianStatus({ ...base, checkFailed: true, agentOnline: false })).toEqual({ dot: "bad", text: "Vault check failed" });
    expect(guardianStatus({ ...base, healthOk: false })).toEqual({ dot: "degraded", text: "Guardian degraded" });
    expect(guardianStatus(base)).toEqual({ dot: "", text: "Guardian online" });
  });
});

describe("appStatus (the protected owner's shell)", () => {
  const a = { unseen: false, hasCfg: true, checkFailed: false, agentOnline: true, agentChecked: true, healthOk: true as boolean | undefined, paused: false };
  it("the vault check failure wins over everything, then an unseen incident", () => {
    expect(appStatus({ ...a, checkFailed: true, unseen: true })).toEqual({ dot: "bad", text: "Vault check failed" });
    expect(appStatus({ ...a, unseen: true })).toEqual({ dot: "degraded", text: "Rescue happened" });
  });
  it("paused, checking, not answering, degraded, then watching", () => {
    expect(appStatus({ ...a, paused: true, agentOnline: false })).toEqual({ dot: "off", text: "Guardian paused" });
    expect(appStatus({ ...a, agentOnline: false, agentChecked: false })).toEqual({ dot: "off", text: "Checking your Guardian…" });
    expect(appStatus({ ...a, agentOnline: false })).toEqual({ dot: "off", text: "Guardian not answering" });
    expect(appStatus({ ...a, hasCfg: false, agentOnline: false })).toEqual({ dot: "off", text: "Guardian not answering" });
    expect(appStatus({ ...a, healthOk: false })).toEqual({ dot: "degraded", text: "Guardian degraded" });
    expect(appStatus({ ...a, healthOk: undefined })).toEqual({ dot: "", text: "Guardian watching" });
    expect(appStatus(a)).toEqual({ dot: "", text: "Guardian watching" });
  });
});
