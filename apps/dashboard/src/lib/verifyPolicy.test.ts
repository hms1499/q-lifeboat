import { describe, expect, it } from "vitest";
import { bodyKey, configKey, needsVerification, shownVerification, type StoredVerification } from "./verifyPolicy";
import type { VerifyResult } from "./verify";

const OK: VerifyResult = { ok: true, checks: [] };
const cfg = {
  owner: "0x7777777777777777777777777777777777777777",
  vault: "0x17d867860a0A0Ff528dF655439ff59176b061B3C",
  guardian: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
} as const;
const inc = (sig: string) => ({ id: "inc-1", sig }) as never;

describe("configKey", () => {
  it("is null while there is no config or its chain check is pending", () => {
    expect(configKey(null, { ok: true })).toBeNull();
    expect(configKey(cfg, null)).toBeNull();
  });

  it("changes with the owner, the vault, the guardian and the check verdict (case-insensitive)", () => {
    const k = configKey(cfg, { ok: true })!;
    expect(configKey({ ...cfg, owner: cfg.owner.toUpperCase().replace("0X", "0x") as never }, { ok: true })).toBe(k);
    expect(configKey({ ...cfg, owner: "0x8888888888888888888888888888888888888888" }, { ok: true })).not.toBe(k);
    expect(configKey({ ...cfg, vault: "0x8888888888888888888888888888888888888888" }, { ok: true })).not.toBe(k);
    expect(configKey({ ...cfg, guardian: "0x8888888888888888888888888888888888888888" }, { ok: true })).not.toBe(k);
    expect(configKey(cfg, { ok: false })).not.toBe(k);
  });
});

describe("shownVerification: what may be shown as a verdict", () => {
  const key = configKey(cfg, { ok: true });
  const stored: StoredVerification = { body: bodyKey(inc("aa")), configKey: key!, round: 0, result: OK };

  it("shows the stored result for the same body (sig) under the same config", () => {
    expect(shownVerification(inc("aa"), stored, key)).toBe(OK);
  });

  it("test_sameIdNewSigIsPending: a body with the same id but another sig never inherits the ✓", () => {
    expect(shownVerification(inc("bb"), stored, key)).toBeUndefined();
  });

  it("a report with the same sig but another body or co-signature is pending, never the stored ✓ (gap 3 review)", () => {
    const withCo = (g: string) => ({ id: "inc-1", sig: "aa", guardianSig: { pq: { signature: g } } }) as never;
    const st: StoredVerification = { body: bodyKey(withCo("x")), configKey: key!, round: 0, result: OK };
    expect(shownVerification(withCo("x"), st, key)).toBe(OK);
    expect(shownVerification(withCo("y"), st, key)).toBeUndefined();
    expect(shownVerification(inc("aa"), st, key)).toBeUndefined(); // co-signature stripped
    expect(shownVerification({ id: "inc-1", sig: "aa", summary: "edited" } as never, stored, key)).toBeUndefined();
    expect(needsVerification(withCo("y"), { ...st, round: 0 }, key!, 0)).toBe(true);
  });

  it("test_configChangeIsPending: a result from another owner/vault/verdict is never shown", () => {
    const other = configKey({ ...cfg, owner: "0x8888888888888888888888888888888888888888" }, { ok: true });
    expect(shownVerification(inc("aa"), stored, other)).toBeUndefined();
    expect(shownVerification(inc("aa"), stored, configKey(cfg, { ok: false }))).toBeUndefined();
  });

  it("test_checkPendingOrUnreadIsPending: while the config check is pending (key null), nothing is shown", () => {
    expect(shownVerification(inc("aa"), stored, null)).toBeUndefined();
  });

  it("nothing stored → pending", () => {
    expect(shownVerification(inc("aa"), undefined, key)).toBeUndefined();
  });
});

describe("needsVerification: what must be (re)verified", () => {
  const key = configKey(cfg, { ok: true })!;
  const stored: StoredVerification = { body: bodyKey(inc("aa")), configKey: key, round: 3, result: OK };

  it("verifies a new report, a new body under an old id, a new config and a new round", () => {
    expect(needsVerification(inc("aa"), undefined, key, 3)).toBe(true);
    expect(needsVerification(inc("bb"), stored, key, 3)).toBe(true);
    expect(needsVerification(inc("aa"), stored, configKey(cfg, { ok: false }), 3)).toBe(true);
    expect(needsVerification(inc("aa"), stored, key, 4)).toBe(true);
  });

  it("skips a report already verified for this body, config and round", () => {
    expect(needsVerification(inc("aa"), stored, key, 3)).toBe(false);
  });

  it("verifies nothing while the config check is pending", () => {
    expect(needsVerification(inc("aa"), undefined, null, 3)).toBe(false);
  });
});
