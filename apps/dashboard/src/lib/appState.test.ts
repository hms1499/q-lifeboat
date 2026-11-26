import { describe, expect, it } from "vitest";
import { appStage, hostedNav, ownerStageFor, resolveRoute } from "./appState";

const hosted = { localAgent: false, hostedBuild: true };

describe("appStage", () => {
  it("unknown while the wallet check or the owner read is pending", () => {
    expect(appStage({ hasSeed: undefined, ownerStage: undefined, ...hosted })).toBeNull();
    expect(appStage({ hasSeed: true, ownerStage: undefined, ...hosted })).toBeNull();
  });

  it("no wallet: a visitor on the hosted build, the builder's local mode with a local agent", () => {
    expect(appStage({ hasSeed: false, ownerStage: undefined, ...hosted })).toBe("visitor");
    expect(appStage({ hasSeed: false, ownerStage: undefined, localAgent: true, hostedBuild: false })).toBe("local");
    expect(appStage({ hasSeed: false, ownerStage: undefined, localAgent: false, hostedBuild: false })).toBe("visitor");
  });

  it("a wallet is protected once its hosted stage is active, and stays so when the service retires an idle Guardian", () => {
    expect(appStage({ hasSeed: true, ownerStage: "active", ...hosted })).toBe("protected");
    // A retired owner keeps its guardian and vault; its next arm revives the Guardian, so it must reach the app (and the Vault).
    expect(appStage({ hasSeed: true, ownerStage: "retired", ...hosted })).toBe("protected");
    for (const s of ["none", "starter", "provisioned"] as const) expect(appStage({ hasSeed: true, ownerStage: s, ...hosted })).toBe("onboarding");
  });
});

describe("resolveRoute", () => {
  it("#/ lands on the screen for the stage", () => {
    expect(resolveRoute("", "visitor")).toBe("home");
    expect(resolveRoute("", "onboarding")).toBe("setup");
    expect(resolveRoute("", "protected")).toBe("dashboard");
    expect(resolveRoute("", "local")).toBe("overview");
    expect(resolveRoute("", null)).toBeNull();
  });

  it("the homepage opens for anyone; a visitor goes nowhere else but setup", () => {
    for (const s of ["visitor", "onboarding", "protected", "local"] as const) expect(resolveRoute("home", s)).toBe("home");
    expect(resolveRoute("vault", "visitor")).toBe("home");
    expect(resolveRoute("setup", "visitor")).toBe("setup");
  });

  it("onboarding stays in setup whatever was asked", () => {
    for (const s of ["dashboard", "vault", "activity", "settings", "overview"]) expect(resolveRoute(s, "onboarding")).toBe("setup");
  });

  it("a protected owner gets the four app screens, old links mapped to them", () => {
    expect(resolveRoute("setup", "protected")).toBe("dashboard");
    expect(resolveRoute("overview", "protected")).toBe("dashboard");
    expect(resolveRoute("attack", "protected")).toBe("dashboard");
    expect(resolveRoute("start", "protected")).toBe("dashboard");
    expect(resolveRoute("incidents", "protected")).toBe("activity");
    expect(resolveRoute("recover", "protected")).toBe("vault");
    expect(resolveRoute("rules", "protected")).toBe("settings");
    expect(resolveRoute("nope", "protected")).toBe("dashboard");
  });

  it("local mode keeps its own screens", () => {
    expect(resolveRoute("incidents", "local")).toBe("incidents");
    expect(resolveRoute("drill", "local")).toBe("drill");
    expect(resolveRoute("protect", "local")).toBe("protect");
    expect(resolveRoute("vault", "local")).toBe("overview");
  });
});

describe("hostedNav", () => {
  it("is Dashboard, Activity, Vault, Settings", () => {
    expect(hostedNav().map((n) => n.id)).toEqual(["dashboard", "activity", "vault", "settings"]);
    expect(hostedNav().map((n) => n.href)).toEqual(["#/dashboard", "#/activity", "#/vault", "#/settings"]);
  });
});

describe("ownerStageFor", () => {
  it("uses the live stage, else the last one seen (service down or first read in flight), else none or waits", () => {
    expect(ownerStageFor("active", null, "none")).toBe("active");
    expect(ownerStageFor(undefined, "HTTP 503", "active")).toBe("active");
    expect(ownerStageFor(undefined, "HTTP 503", null)).toBe("none");
    expect(ownerStageFor(undefined, null, "active")).toBe("active");
    expect(ownerStageFor(undefined, null, null)).toBeUndefined();
  });
});
