import { generatePqcRecoveryCode } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { confirmPicks } from "./session";
import { autoRun, phaseOf, recoveryFile, type AutoInput } from "./setup";

describe("phaseOf", () => {
  it("maps the seven journey steps onto three phases", () => {
    expect(phaseOf("account")).toBe(1);
    expect(phaseOf("code")).toBe(1);
    expect(phaseOf("starter")).toBe(2);
    for (const s of ["register", "guardian", "vault", "protect"] as const) expect(phaseOf(s)).toBe(3);
    for (const s of ["attack", "withdraw", "done"] as const) expect(phaseOf(s)).toBe("done");
  });
});

describe("recoveryFile", () => {
  it("holds the normalised code, the account and the warning that the code alone withdraws", () => {
    const code = generatePqcRecoveryCode();
    const f = recoveryFile(code.toLowerCase(), "0x337a4e2118c11cfc858831f7388ec0c8d9a156b6");
    expect(f).toContain(code.toUpperCase());
    expect(f).toContain("0x337a4e2118c11cfc858831f7388ec0c8d9a156b6");
    expect(f).toContain("Anyone with this code can withdraw everything in your vault. Keep this file private.");
    expect(f).not.toContain("wallet password");
  });
});

describe("confirmPicks with a count", () => {
  it("draws n distinct sorted groups between 1 and 14", () => {
    const code = generatePqcRecoveryCode();
    for (let i = 0; i < 20; i++) {
      const p = confirmPicks(code, 2);
      expect(p).toHaveLength(2);
      expect(new Set(p).size).toBe(2);
      expect([...p].sort((a, b) => a - b)).toEqual(p);
      expect(p.every((n) => n >= 1 && n <= 14)).toBe(true);
    }
    expect(confirmPicks(code)).toHaveLength(3);
  });
});

describe("autoRun", () => {
  const base: AutoInput = {
    step: "register",
    detail: "register your post-quantum (ML-DSA-87) key on chain",
    auto: true,
    busy: false,
    failed: false,
    last: null,
    unlocked: true,
    registered: false,
    vaultLookup: "reading",
    vaultError: null,
    vault: false,
  };

  it("runs each phase-3 step once its inputs are read", () => {
    expect(autoRun(base)).toEqual({ kind: "run", step: "register" });
    expect(autoRun({ ...base, step: "guardian", registered: true })).toEqual({ kind: "run", step: "guardian" });
    expect(autoRun({ ...base, step: "vault", registered: true, vaultLookup: "none" })).toEqual({ kind: "run", step: "vault" });
    expect(autoRun({ ...base, step: "protect", registered: true, vaultLookup: "found", vault: true, detail: "approve fUSD for the vault" })).toEqual({ kind: "run", step: "protect" });
  });

  it("does nothing while auto is off, a step runs or the last one failed, and outside phase 3", () => {
    expect(autoRun({ ...base, auto: false })).toEqual({ kind: "idle" });
    expect(autoRun({ ...base, busy: true })).toEqual({ kind: "idle" });
    expect(autoRun({ ...base, failed: true })).toEqual({ kind: "idle" });
    for (const step of ["account", "code", "starter", "attack", "finished"]) expect(autoRun({ ...base, step })).toEqual({ kind: "idle" });
  });

  it("stops when the signing keys are gone", () => {
    expect(autoRun({ ...base, unlocked: false })).toEqual({ kind: "locked" });
  });

  it("waits, with the step's status, while inputs are read and after a step it already started", () => {
    expect(autoRun({ ...base, registered: undefined })).toEqual({ kind: "wait", detail: base.detail });
    expect(autoRun({ ...base, step: "vault", registered: true, vaultLookup: "reading", detail: "looking for your vault on chain (reading)" })).toEqual({
      kind: "wait",
      detail: "looking for your vault on chain (reading)",
    });
    expect(autoRun({ ...base, step: "protect", registered: true, vault: true, detail: "reading your approvals and the Guardian's link" }).kind).toBe("wait");
    expect(autoRun({ ...base, step: "protect", registered: true, vault: false, detail: "approve fUSD for the vault" }).kind).toBe("wait");
    // Never the same step twice: a step that succeeded waits for the chain reads to move on.
    expect(autoRun({ ...base, last: "register" })).toEqual({ kind: "wait", detail: base.detail });
  });

  it("is blocked, with the reason, on states no retry fixes", () => {
    const noPop = "this account's post-quantum key is registered without a proof of possession: it can't be protected";
    expect(autoRun({ ...base, registered: true, detail: noPop })).toEqual({ kind: "blocked", detail: noPop, retry: false });
    const other = "the vault found names guardian 0xabc, not your Guardian 0xdef: it can't be used";
    expect(autoRun({ ...base, step: "vault", registered: true, vaultLookup: "found", detail: other })).toEqual({ kind: "blocked", detail: other, retry: false });
    // Blocked whether or not the auto-run is on, so the screen can say so before the owner clicks.
    expect(autoRun({ ...base, auto: false, registered: true, detail: noPop }).kind).toBe("blocked");
  });

  it("never interrupts a running step: a blocker read meanwhile shows once it is done", () => {
    expect(autoRun({ ...base, step: "vault", registered: true, vaultLookup: "reading", vaultError: "HTTP 502", busy: true })).toEqual({ kind: "idle" });
  });

  it("is blocked with a retry when the vault lookup fails, never a deploy on an unknown answer", () => {
    expect(autoRun({ ...base, step: "vault", registered: true, vaultLookup: "reading", vaultError: "HTTP 502" })).toEqual({
      kind: "blocked",
      detail: "could not look for your vault on chain (HTTP 502)",
      retry: true,
    });
  });
});
