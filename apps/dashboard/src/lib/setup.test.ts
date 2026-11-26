import { generatePqcRecoveryCode } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { confirmPicks } from "./session";
import { phaseOf, recoveryFile } from "./setup";

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
  it("holds the normalised code, the account and the privacy warning", () => {
    const code = generatePqcRecoveryCode();
    const f = recoveryFile(code.toLowerCase(), "0x337a4e2118c11cfc858831f7388ec0c8d9a156b6");
    expect(f).toContain(code.toUpperCase());
    expect(f).toContain("0x337a4e2118c11cfc858831f7388ec0c8d9a156b6");
    expect(f).toContain("Anyone with this code and your wallet password can sign withdrawals");
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
