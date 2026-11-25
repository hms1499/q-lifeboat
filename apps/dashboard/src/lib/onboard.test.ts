import type { HostedStatus, OwnerPublicState } from "@qday/core";
import type { PqcStatus } from "@qorechain/sdk";
import { getContractAddress, maxUint256, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  landingStart,
  loadCodeConfirmed,
  locateVault,
  canStartOver,
  nextOnboardStep,
  protectWindowPlan,
  saveCodeConfirmed,
  STARTER_MIN_UQOR,
  type OnboardInput,
} from "./onboard";

const OWNER = "0x0698a02ea2d4ce6a064bf9a61b5c6f8dd0879557" as Hex;
const GUARDIAN = "0x1111111111111111111111111111111111111111" as Hex;
const OTHER = "0x2222222222222222222222222222222222222222" as Hex;
const VAULT = "0x3333333333333333333333333333333333333333" as Hex;

const REGISTERED: PqcStatus = { registered: true, possessionProven: true } as PqcStatus;
const UNREGISTERED: PqcStatus = { registered: false } as PqcStatus;
const MAX = { fUSD: maxUint256, fETH: maxUint256, fBTC: maxUint256 };
const NONE = { fUSD: 0n, fETH: 0n, fBTC: 0n };

/** A brand-new wallet whose code is confirmed: everything after it still to do. */
const base: OnboardInput = {
  hasSeed: true,
  codeConfirmed: true,
  uqor: 0n,
  pqc: UNREGISTERED,
  state: { stage: "none" },
  vault: null,
  allowances: NONE,
  linked: false,
  ruleExact: false,
};
const provisioned: OwnerPublicState = { stage: "provisioned", guardian: GUARDIAN };
/** Registered, guardian provisioned, vault deployed with the right roles. */
const deployed: OnboardInput = { ...base, uqor: 1_000_000n, pqc: REGISTERED, state: provisioned, vault: { owner: OWNER, guardian: GUARDIAN } };

describe("nextOnboardStep", () => {
  it("account: no wallet in this browser", () => {
    expect(nextOnboardStep({ ...base, hasSeed: false }).step).toBe("account");
  });

  it("code: wallet created but the recovery code not confirmed", () => {
    expect(nextOnboardStep({ ...base, codeConfirmed: false }).step).toBe("code");
  });

  it("code: unconfirmed and the key status still reading stays on code", () => {
    expect(nextOnboardStep({ ...base, codeConfirmed: false, pqc: undefined }).step).toBe("code");
  });

  it("a registered key implies the code step was passed (the flag can be lost with browser storage)", () => {
    expect(nextOnboardStep({ ...deployed, codeConfirmed: false }).step).not.toBe("code");
  });

  it("starter: no starter pack taken yet", () => {
    const r = nextOnboardStep(base);
    expect(r.step).toBe("starter");
    expect(r.detail).toMatch(/starter pack/i);
  });

  it("starter: hosted state still reading", () => {
    const r = nextOnboardStep({ ...base, state: undefined });
    expect(r.step).toBe("starter");
    expect(r.detail).toMatch(/reading/);
  });

  it("starter: uqor undefined stays on starter with 'reading'", () => {
    const r = nextOnboardStep({ ...base, state: { stage: "starter" }, uqor: undefined });
    expect(r.step).toBe("starter");
    expect(r.detail).toMatch(/reading/);
  });

  it("starter: pack sent but the balance has not arrived", () => {
    const r = nextOnboardStep({ ...base, state: { stage: "starter" }, uqor: STARTER_MIN_UQOR - 1n });
    expect(r.step).toBe("starter");
    expect(r.detail).toMatch(/waiting/);
  });

  it("starter: own QOR without a starter pack is not enough (onboarding needs the pack)", () => {
    expect(nextOnboardStep({ ...base, state: { stage: "none" }, uqor: 10_000_000n }).step).toBe("starter");
  });

  it("register: starter arrived, key not registered", () => {
    expect(nextOnboardStep({ ...base, state: { stage: "starter" }, uqor: STARTER_MIN_UQOR }).step).toBe("register");
  });

  it("register: key status still reading does not skip ahead", () => {
    const r = nextOnboardStep({ ...base, state: { stage: "starter" }, uqor: STARTER_MIN_UQOR, pqc: undefined });
    expect(r.step).toBe("starter");
    expect(r.detail).toMatch(/reading/);
  });

  it("register: a key registered without proof of possession blocks", () => {
    const r = nextOnboardStep({ ...base, state: { stage: "starter" }, uqor: STARTER_MIN_UQOR, pqc: { registered: true, possessionProven: false } as PqcStatus });
    expect(r.step).toBe("register");
    expect(r.detail).toMatch(/proof of possession/);
  });

  it("a registered key moves past starter and register even with a low balance", () => {
    expect(nextOnboardStep({ ...base, state: { stage: "starter" }, uqor: 100n, pqc: REGISTERED }).step).toBe("guardian");
  });

  it("guardian: registered, stage starter", () => {
    expect(nextOnboardStep({ ...base, state: { stage: "starter" }, uqor: STARTER_MIN_UQOR, pqc: REGISTERED }).step).toBe("guardian");
  });

  it("stage provisioned → never guardian again", () => {
    for (const vault of [null, undefined, { owner: OWNER, guardian: GUARDIAN }]) {
      expect(nextOnboardStep({ ...deployed, vault }).step).not.toBe("guardian");
    }
    expect(nextOnboardStep({ ...deployed, vault: null }).step).toBe("vault");
  });

  it("vault: provisioned, no vault yet", () => {
    const r = nextOnboardStep({ ...deployed, vault: null });
    expect(r.step).toBe("vault");
    expect(r.detail).toMatch(/create/i);
  });

  it("vault: still looking for the vault is 'reading', never done", () => {
    const r = nextOnboardStep({ ...deployed, vault: undefined });
    expect(r.step).toBe("vault");
    expect(r.detail).toMatch(/reading|looking/);
  });

  it("vault: a vault with another guardian is not this account's", () => {
    const r = nextOnboardStep({ ...deployed, vault: { owner: OWNER, guardian: OTHER } });
    expect(r.step).toBe("vault");
    expect(r.detail).toMatch(/guardian/);
  });

  it("a deployed vault with no link → protect, never vault again", () => {
    const r = nextOnboardStep(deployed);
    expect(r.step).toBe("protect");
    expect(nextOnboardStep({ ...deployed, allowances: MAX }).step).toBe("protect");
    expect(nextOnboardStep({ ...deployed, linked: true, ruleExact: true }).step).toBe("protect");
  });

  it("protect: reads still pending say 'reading'", () => {
    for (const k of ["allowances", "linked", "ruleExact"] as const) {
      const r = nextOnboardStep({ ...deployed, [k]: undefined });
      expect(r.step).toBe("protect");
      expect(r.detail).toMatch(/reading/);
    }
  });

  it("protect: approvals and link on chain but not activated → protect (activate)", () => {
    const r = nextOnboardStep({ ...deployed, allowances: MAX, linked: true, ruleExact: true });
    expect(r.step).toBe("protect");
    expect(r.detail).toMatch(/activat/i);
  });

  it("protect: a link with the wrong rule is not done", () => {
    const r = nextOnboardStep({ ...deployed, allowances: MAX, linked: true, ruleExact: false, state: { ...provisioned, stage: "active", vault: VAULT } });
    expect(r.step).toBe("protect");
  });

  it("attack: everything on chain and the Guardian active", () => {
    const r = nextOnboardStep({ ...deployed, allowances: MAX, linked: true, ruleExact: true, state: { ...provisioned, stage: "active", vault: VAULT } });
    expect(r.step).toBe("attack");
  });

  it("an active owner whose approvals were revoked goes back to protect", () => {
    const r = nextOnboardStep({ ...deployed, allowances: { ...MAX, fETH: 0n }, linked: true, ruleExact: true, state: { ...provisioned, stage: "active", vault: VAULT } });
    expect(r.step).toBe("protect");
    expect(r.detail).toMatch(/fETH/);
  });
});

describe("landingStart", () => {
  it("status paused → start disabled with the reason", () => {
    const s: HostedStatus = { onboarding: "paused", reason: "funder-low", activeGuardians: 3 };
    const r = landingStart(s, null);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/paused/i);
    expect(r.reason).toMatch(/QOR/);
  });

  it("daily cap has its own reason", () => {
    const r = landingStart({ onboarding: "paused", reason: "daily-cap", activeGuardians: 0 }, null);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/tomorrow/i);
  });

  it("an unknown pause reason is still shown", () => {
    const r = landingStart({ onboarding: "paused", reason: "maintenance", activeGuardians: 0 }, null);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/maintenance/);
  });

  it("open → enabled", () => {
    expect(landingStart({ onboarding: "open", activeGuardians: 1 }, null)).toEqual({ enabled: true, reason: null });
  });

  it("still reading → disabled, never enabled by default", () => {
    const r = landingStart(undefined, null);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/checking/i);
  });

  it("the service unreachable → disabled with the reason", () => {
    const r = landingStart(undefined, "HTTP 502");
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/not reachable/);
  });
});

describe("code confirmed flag", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("is per owner, case-insensitive, and false when storage is missing", () => {
    const s = mem();
    expect(loadCodeConfirmed(s, OWNER)).toBe(false);
    saveCodeConfirmed(s, OWNER.toUpperCase().replace("0X", "0x"));
    expect(loadCodeConfirmed(s, OWNER)).toBe(true);
    expect(loadCodeConfirmed(s, OTHER)).toBe(false);
    expect(loadCodeConfirmed(undefined, OWNER)).toBe(false);
    expect(() => saveCodeConfirmed(undefined, OWNER)).not.toThrow();
  });
});

describe("locateVault", () => {
  const roles = (map: Record<string, { owner: Hex; guardian: Hex } | null>) => async (a: Hex) => map[a.toLowerCase()] ?? null;

  it("the saved vault wins when its owner and guardian match", async () => {
    const r = await locateVault({ owner: OWNER, guardian: GUARDIAN, stored: VAULT, hosted: undefined }, { txCount: async () => 9, roles: roles({ [VAULT]: { owner: OWNER, guardian: GUARDIAN } }) });
    expect(r).toEqual({ address: VAULT, roles: { owner: OWNER, guardian: GUARDIAN } });
  });

  it("falls back to the service's vault when nothing is saved", async () => {
    const r = await locateVault({ owner: OWNER, guardian: GUARDIAN, stored: null, hosted: VAULT }, { txCount: async () => 0, roles: roles({ [VAULT]: { owner: OWNER, guardian: GUARDIAN } }) });
    expect(r?.address).toBe(VAULT);
  });

  it("finds a vault this owner deployed earlier from its own tx nonces (browser storage lost)", async () => {
    const at3 = getContractAddress({ from: OWNER, nonce: 3n }).toLowerCase() as Hex;
    const r = await locateVault({ owner: OWNER, guardian: GUARDIAN, stored: null, hosted: undefined }, { txCount: async () => 6, roles: roles({ [at3]: { owner: OWNER, guardian: GUARDIAN } }) });
    expect(r?.address.toLowerCase()).toBe(at3);
  });

  it("ignores a contract at a nonce address whose owner or guardian differ", async () => {
    const at0 = getContractAddress({ from: OWNER, nonce: 0n }).toLowerCase() as Hex;
    const r = await locateVault({ owner: OWNER, guardian: GUARDIAN, stored: null, hosted: undefined }, { txCount: async () => 2, roles: roles({ [at0]: { owner: OWNER, guardian: OTHER } }) });
    expect(r).toBeNull();
  });

  it("a saved vault with the wrong roles is not used", async () => {
    const r = await locateVault({ owner: OWNER, guardian: GUARDIAN, stored: VAULT, hosted: undefined }, { txCount: async () => 0, roles: roles({ [VAULT]: { owner: OTHER, guardian: GUARDIAN } }) });
    expect(r).toBeNull();
  });

  it("null with no tx sent and nothing saved", async () => {
    expect(await locateVault({ owner: OWNER, guardian: GUARDIAN, stored: null, hosted: undefined }, { txCount: async () => 0, roles: roles({}) })).toBeNull();
  });

  it("a read error propagates (never read as 'no vault', which would offer a second deploy)", async () => {
    await expect(
      locateVault({ owner: OWNER, guardian: GUARDIAN, stored: null, hosted: undefined }, { txCount: async () => { throw new Error("rpc down"); }, roles: roles({}) }),
    ).rejects.toThrow("rpc down");
  });
});

const TOKENS = { fUSD: "0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14", fETH: "0x0a958bba25f5fddca1b1f9cec44bdf076a8ea6c5", fBTC: "0xbd16bc9ffaddf241593d891844cc4281f5af903e" } as const;

describe("protectWindowPlan", () => {
  it("mints the tokens the owner holds none of (account + vault), approves the open ones, scoped to exactly those tokens", () => {
    const p = protectWindowPlan({ fUSD: 0n, fETH: maxUint256, fBTC: 0n }, { fUSD: 100n, fETH: 0n, fBTC: 0n }, TOKENS);
    expect(p.mint).toEqual(["fETH", "fBTC"]);
    expect(p.approve).toEqual(["fUSD", "fBTC"]);
    expect(p.txs).toBe(4);
    expect(p.scope).toEqual([TOKENS.fUSD, TOKENS.fETH, TOKENS.fBTC]);
  });

  it("only the approvals still open, scoped to those tokens only", () => {
    const p = protectWindowPlan({ fUSD: maxUint256, fETH: 0n, fBTC: maxUint256 }, { fUSD: 1n, fETH: 1n, fBTC: 1n }, TOKENS);
    expect(p).toEqual({ mint: [], approve: ["fETH"], txs: 1, scope: [TOKENS.fETH] });
  });

  it("tokens rescued into the vault count as held: no second mint", () => {
    expect(protectWindowPlan(MAX, { fUSD: 0n, fETH: 0n, fBTC: 0n }, TOKENS, { fUSD: 90n, fETH: 90n, fBTC: 90n }).mint).toEqual([]);
  });

  it("nothing to do → no window", () => {
    expect(protectWindowPlan(MAX, { fUSD: 1n, fETH: 1n, fBTC: 1n }, TOKENS)).toEqual({ mint: [], approve: [], txs: 0, scope: [] });
  });
});

describe("nextOnboardStep: tokens a half-done vault step never minted", () => {
  it("protect lists the missing mints before activation", () => {
    const p = nextOnboardStep({ ...deployed, allowances: MAX, linked: true, ruleExact: true, holdings: { fUSD: 100n, fETH: 0n, fBTC: 0n } });
    expect(p).toEqual({ step: "protect", detail: "mint fETH, fBTC" });
  });

  it("holdings still reading do not block the activation label", () => {
    expect(nextOnboardStep({ ...deployed, allowances: MAX, linked: true, ruleExact: true, holdings: undefined }).step).toBe("protect");
  });
});

describe("canStartOver", () => {
  it("only while nothing is funded or registered for this wallet", () => {
    expect(canStartOver({ stage: "none" }, UNREGISTERED)).toBe(true);
    expect(canStartOver({ stage: "starter" }, UNREGISTERED)).toBe(false);
    expect(canStartOver({ stage: "none" }, REGISTERED)).toBe(false);
    expect(canStartOver(undefined, UNREGISTERED)).toBe(false);
    expect(canStartOver({ stage: "none" }, undefined)).toBe(false);
  });
});
