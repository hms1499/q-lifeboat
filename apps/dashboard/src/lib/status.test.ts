import { describe, expect, it } from "vitest";
import { guardianStatus, type StatusInput } from "./status";

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
