import { evmWindowCost } from "@qorechain/evm/window";
import type { AuthenticatorView, SpendingRules } from "@qorechain/sdk";
import { maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import type { Health, Policy } from "./agent";
import type { AgentConfig } from "./config";
import {
  APPROVE_GAS,
  DEPLOY_GAS,
  deployOffer,
  onboardingWindowOpen,
  ownerEnvNote,
  START_AGENT_HINT,
  loadProtectState,
  planApprove,
  planDeploy,
  protectCommands,
  protectSteps,
  recoveryWarning,
  saveProtectState,
  signWithdrawCommand,
  tokensToApprove,
  validateRecovery,
  vaultRoleProblems,
  type ProtectInput,
} from "./protect";

const OWNER = "0x7777777777777777777777777777777777777777";
const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const GUARDIAN = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x4444444444444444444444444444444444444444";
const fUSD = "0x1111111111111111111111111111111111111111";
const fETH = "0x2222222222222222222222222222222222222222";
const fBTC = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000;
const FEE = 100_000_000_000n;

const config: AgentConfig = { owner: OWNER, vault: VAULT, guardian: GUARDIAN, tokens: { fUSD, fETH, fBTC }, evmChainId: 9800 };
const auth = (over: Partial<AuthenticatorView> = {}): AuthenticatorView => ({
  scheme: "ed25519",
  pubkeyHex: "ab",
  permissions: [],
  expiryUnix: BigInt(NOW + 3600),
  label: "agent",
  createdAtUnix: 0n,
  revoked: false,
  hasSpendRule: false,
  ...over,
});
const rule = (over: Record<string, unknown> = {}) =>
  ({ enabled: true, allowedEvmCalls: [`${VAULT.toLowerCase()}/0x839006f2`], allowedDenoms: ["uqor"], denomLimits: [], perTxLimit: 0n, dailyLimit: 0n, ...over }) as unknown as SpendingRules["rules"][number];
const rules = (r: SpendingRules["rules"][number][] = [rule()]): SpendingRules => ({ rules: r, authenticatorRules: [] });
const health = (low = false): Health => ({
  ok: true,
  startedAt: "",
  lastBlock: null,
  lastBlockAt: null,
  window: null,
  gas: { guardian: GUARDIAN, balance: "1", threshold: "1", low },
  alerts: { telegram: true, webhook: false },
});
const policy = (n: number): Policy => ({ trusted: Array.from({ length: n }, (_, i) => ({ label: `t${i}`, address: OTHER, kind: "wallet" as const })), maxOutbound: "0" });

/** Everything done. */
const full = (over: Partial<ProtectInput> = {}): ProtectInput => ({
  wallet: OWNER,
  chainId: 9800,
  pqc: { registered: true, possessionProven: true },
  vault: VAULT,
  vaultRoles: { owner: OWNER, guardian: GUARDIAN },
  allowances: { fUSD: maxUint256, fETH: maxUint256, fBTC: maxUint256 },
  authenticators: [auth()],
  rules: rules(),
  config,
  configCheck: { ok: true, detail: "" },
  online: true,
  health: health(),
  policy: policy(1),
  local: { vault: VAULT, recovery: OTHER, trustedReviewed: false },
  nowUnix: NOW,
  window: { live: false, remainingTxs: 0n, remainingValue: 0n, allowedTargets: [] },
  ...over,
});
const ids = ["connect", "vault", "approve", "guardian", "trusted", "recovery"];
const byId = (i: ProtectInput) => Object.fromEntries(protectSteps(i).map((s) => [s.id, s]));

describe("protectSteps", () => {
  it("returns six steps in order; all done when every read is good", () => {
    const s = protectSteps(full());
    expect(s.map((x) => x.id)).toEqual(ids);
    expect(s.map((x) => x.state)).toEqual(Array(6).fill("done"));
  });

  it("the first not-done step is current, later not-done ones todo, later done ones stay done", () => {
    const s = protectSteps(full({ allowances: { fUSD: 0n, fETH: maxUint256, fBTC: maxUint256 }, policy: policy(0), local: { vault: VAULT, recovery: null, trustedReviewed: false } }));
    expect(s.map((x) => x.state)).toEqual(["done", "done", "current", "done", "todo", "todo"]);
  });

  describe("connect", () => {
    it("no wallet or wrong chain: current with an action, not blocked", () => {
      const a = byId(full({ wallet: null, chainId: null })).connect;
      expect(a.state).toBe("current");
      expect(a.detail).toMatch(/connect/i);
      const b = byId(full({ chainId: 1 })).connect;
      expect(b.state).toBe("current");
      expect(b.detail).toMatch(/9800/);
    });
    it("PQC status still loading is never done and never blocked", () => {
      const c = byId(full({ pqc: undefined })).connect;
      expect(c.state).toBe("current");
      expect(c.detail).toMatch(/reading/);
    });
    it("not registered: blocked with the fresh-owner hint", () => {
      const c = byId(full({ pqc: { registered: false } })).connect;
      expect(c.state).toBe("blocked");
      expect(c.detail).toContain("pnpm cli fresh-owner --no-vault");
    });
    it("registered without proven possession is not done", () => {
      const c = byId(full({ pqc: { registered: true, possessionProven: false } })).connect;
      expect(c.state).toBe("blocked");
      expect(c.detail).toMatch(/possession/);
    });
  });

  describe("vault", () => {
    it("no vault yet: current, names the owner and guardian the deploy will use", () => {
      const v = byId(full({ vault: null, vaultRoles: undefined, local: { vault: null, recovery: null, trustedReviewed: false } })).vault;
      expect(v.state).toBe("current");
      expect(v.detail).toContain(GUARDIAN);
    });
    it("no agent config: blocked, tells to start the agent", () => {
      const v = byId(full({ config: null, vault: null, vaultRoles: undefined })).vault;
      expect(v.state).toBe("blocked");
      expect(v.detail).toBe(START_AGENT_HINT);
      expect(v.detail).toContain("root .env");
    });
    it("config still loading is not blocked", () => {
      const v = byId(full({ config: undefined, vault: null, vaultRoles: undefined })).vault;
      expect(v.state).toBe("current");
      expect(v.detail).toMatch(/reading/);
    });
    it("roles still loading: not done, not blocked", () => {
      const v = byId(full({ vaultRoles: undefined })).vault;
      expect(v.state).toBe("current");
      expect(v.detail).toMatch(/reading/);
    });
    it("owner and guardian compare case-insensitively", () => {
      const v = byId(full({ vaultRoles: { owner: OWNER.toUpperCase().replace("0X", "0x"), guardian: GUARDIAN.toLowerCase() } })).vault;
      expect(v.state).toBe("done");
    });
    it("a known vault with other roles is blocked and names both", () => {
      const v = byId(full({ vaultRoles: { owner: OTHER, guardian: GUARDIAN } })).vault;
      expect(v.state).toBe("blocked");
      expect(v.detail).toContain(OTHER);
      expect(v.detail).toContain(OWNER);
      const g = byId(full({ vaultRoles: { owner: OWNER, guardian: OTHER } })).vault;
      expect(g.state).toBe("blocked");
      expect(g.detail).toContain(OTHER);
      expect(g.detail).toContain(GUARDIAN);
    });
    it("no wallet: not done", () => {
      expect(byId(full({ wallet: null, chainId: null })).vault.state).not.toBe("done");
    });
  });

  describe("approve", () => {
    it("done only when all three allowances are maxUint256", () => {
      expect(byId(full()).approve.state).toBe("done");
      const a = byId(full({ allowances: { fUSD: maxUint256, fETH: maxUint256 - 1n, fBTC: maxUint256 } })).approve;
      expect(a.state).toBe("current");
      expect(a.detail).toContain("fETH");
      expect(a.detail).not.toContain("fUSD");
    });
    it("loading allowances are not done", () => {
      const a = byId(full({ allowances: undefined })).approve;
      expect(a.state).toBe("current");
      expect(a.detail).toMatch(/reading/);
    });
    it("no vault: needs the vault first", () => {
      const a = byId(full({ vault: null, vaultRoles: undefined, allowances: undefined, local: { vault: null, recovery: null, trustedReviewed: false } })).approve;
      expect(a.state).toBe("todo");
      expect(a.detail).toMatch(/vault/);
    });
  });

  describe("guardian", () => {
    const missing = (over: Partial<ProtectInput>) => byId(full(over)).guardian;
    it("done when linked, rule exact, agent online with matching config and gas ok", () => {
      expect(missing({}).state).toBe("done");
    });
    it("no authenticator, revoked, expiring within 60 s: each listed", () => {
      expect(missing({ authenticators: [] }).detail).toMatch(/link/i);
      expect(missing({ authenticators: [auth({ revoked: true })] }).state).toBe("current");
      expect(missing({ authenticators: [auth({ expiryUnix: BigInt(NOW + 60) })] }).state).toBe("current");
      expect(missing({ authenticators: [auth({ expiryUnix: BigInt(NOW + 61) })] }).state).toBe("done");
    });
    it("rule must be exactly vault.rescue + uqor (first enabled rule)", () => {
      expect(missing({ rules: rules([]) }).state).toBe("current");
      expect(missing({ rules: rules([rule({ allowedDenoms: ["uqor", `erc20/${fUSD}`] })]) }).detail).toMatch(/rule/i);
      expect(missing({ rules: rules([rule({ allowedEvmCalls: [`${OTHER}/0x839006f2`] })]) }).state).toBe("current");
      expect(missing({ rules: rules([rule({ enabled: false, allowedDenoms: [] }), rule()]) }).state).toBe("done");
      expect(missing({ rules: rules([rule({ allowedDenoms: [] }), rule()]) }).state).toBe("current");
    });
    it("agent offline, config for another owner or vault, config check failing, gas low", () => {
      expect(missing({ online: false }).detail).toMatch(/pnpm agent/);
      expect(missing({ config: { ...config, owner: OTHER } }).detail).toMatch(/owner/);
      expect(missing({ config: { ...config, vault: OTHER } }).detail).toMatch(/vault/);
      expect(missing({ configCheck: { ok: false, detail: "vault.owner() is x" } }).detail).toContain("vault.owner() is x");
      const low = missing({ health: health(true) });
      expect(low.state).toBe("current");
      expect(low.detail).toMatch(/gas/i);
    });
    it("lists every missing part", () => {
      const d = missing({ authenticators: [], rules: rules([]), online: false, health: undefined }).detail;
      expect(d).toMatch(/link/i);
      expect(d).toMatch(/rule/i);
      expect(d).toMatch(/agent/i);
    });
    it("loading reads never count as done and say reading", () => {
      for (const over of [{ authenticators: undefined }, { rules: undefined }, { online: undefined }, { health: undefined }, { configCheck: undefined }]) {
        const g = missing(over);
        expect(g.state).toBe("current");
        expect(g.detail).toMatch(/reading/);
      }
    });
    it("no vault yet: needs the vault first", () => {
      const g = byId(full({ vault: null, vaultRoles: undefined, local: { vault: null, recovery: null, trustedReviewed: false } })).guardian;
      expect(g.state).toBe("todo");
    });
  });

  describe("trusted", () => {
    it("done with a policy entry or a local review; loading is not done", () => {
      expect(byId(full({ policy: policy(0) })).trusted.state).toBe("current");
      expect(byId(full({ policy: policy(0), local: { vault: VAULT, recovery: OTHER, trustedReviewed: true } })).trusted.state).toBe("done");
      expect(byId(full({ policy: undefined, local: { vault: VAULT, recovery: OTHER, trustedReviewed: true } })).trusted.state).toBe("done");
      const l = byId(full({ policy: undefined })).trusted;
      expect(l.state).toBe("current");
      expect(l.detail).toMatch(/reading/);
    });
  });

  describe("recovery", () => {
    it("done only when a recovery address is saved", () => {
      expect(byId(full({ local: { vault: VAULT, recovery: null, trustedReviewed: false } })).recovery.state).toBe("current");
      expect(byId(full()).recovery.state).toBe("done");
    });
  });
});

describe("validateRecovery", () => {
  const roles = { owner: OWNER, vault: VAULT, guardian: GUARDIAN };
  it("accepts another 0x address, trimmed", () => {
    expect(validateRecovery(` ${OTHER} `, roles)).toEqual({ ok: true, address: OTHER });
  });
  it("refuses a non-address and the owner, vault or guardian in any case", () => {
    for (const bad of ["", "0x123", "hello", OTHER.slice(0, 41)]) expect(validateRecovery(bad, roles).ok).toBe(false);
    for (const a of [OWNER, VAULT.toLowerCase(), GUARDIAN.toUpperCase().replace("0X", "0x")]) {
      const r = validateRecovery(a, roles);
      expect(r.ok).toBe(false);
    }
  });
});

describe("commands", () => {
  it("protectCommands: exact strings with a one-line env note each", () => {
    const c = protectCommands(OWNER, VAULT);
    expect(c.window.command).toBe(`pnpm cli window open --onboard --expect ${OWNER}`);
    expect(c.link.command).toBe(`pnpm cli link --expect ${OWNER}`);
    expect(c.agent.command).toBe("pnpm agent");
    for (const x of [c.window, c.link, c.agent]) expect(x.note).not.toContain("\n");
    expect(c.window.note).toContain("OWNER_MNEMONIC");
    expect(c.link.note).toBe(`Load this owner's run.env (OWNER_MNEMONIC, AGENT_ED25519_SK) and export VAULT_ADDRESS=${VAULT}`);
    expect(c.agent.note).toBe(
      `Load this owner's run.env (OWNER_EVM_ADDRESS=${OWNER}, AGENT_ED25519_SK) and export VAULT_ADDRESS=${VAULT}; stop any other agent on :8787 first`,
    );
    expect(c.agent.note).not.toContain("OWNER_MNEMONIC");
  });
  it("signWithdrawCommand", () => {
    expect(signWithdrawCommand(OTHER, "fUSD", "5")).toBe(`pnpm cli sign-withdraw ${OTHER} fUSD 5`);
  });
});

describe("planDeploy", () => {
  const win = (over = {}) => ({ live: true, remainingTxs: 3n, remainingValue: 10_000_000_000n, allowedTargets: [] as string[], ...over });
  const deploy = (over = {}) => planDeploy({ wallet: OWNER, chainId: 9800, window: win(), maxFeePerGas: FEE, ...over });
  const onboard = `pnpm cli window open --onboard --expect ${OWNER}`;

  it("constants: tight gas limits", () => {
    expect(DEPLOY_GAS).toBe(950_000n);
    expect(APPROVE_GAS).toBe(100_000n);
  });
  it("happy path: unscoped live window, cost = deploy gas at the fee cap", () => {
    const p = deploy();
    expect(p.blockers).toEqual([]);
    expect(p.cost).toBe(evmWindowCost({ gas: DEPLOY_GAS, maxFeePerGas: FEE }));
    expect(p.command).toBeNull();
  });
  it("closed window yields the --onboard command", () => {
    const p = deploy({ window: win({ live: false }) });
    expect(p.blockers).toEqual(["the owner's EVM window is closed"]);
    expect(p.command).toBe(onboard);
  });
  it("a scoped window refuses contract creation", () => {
    const p = deploy({ window: win({ allowedTargets: [VAULT] }) });
    expect(p.blockers.join()).toMatch(/scoped/);
    expect(p.command).toBe(onboard);
  });
  it("no tx or too little budget left", () => {
    expect(deploy({ window: win({ remainingTxs: 0n }) }).command).toBe(onboard);
    const p = deploy({ window: win({ remainingValue: 1n }) });
    expect(p.blockers.join()).toMatch(/budget/);
    expect(p.command).toBe(onboard);
  });
  it("loading reads and wallet problems are blockers without a command", () => {
    expect(deploy({ window: undefined }).blockers).toEqual(["reading the owner's EVM window"]);
    expect(deploy({ maxFeePerGas: undefined }).blockers).toEqual(["reading the network fee"]);
    const p = deploy({ wallet: null, chainId: null });
    expect(p.blockers).toEqual(["connect the owner's wallet"]);
    expect(p.command).toBeNull();
    expect(deploy({ chainId: 1 }).blockers).toEqual(["switch the wallet to diana (9800)"]);
  });
});

describe("tokensToApprove and planApprove", () => {
  const tokens = { fUSD, fETH, fBTC };
  const win = (over = {}) => ({ live: true, remainingTxs: 5n, remainingValue: 10_000_000_000n, allowedTargets: [] as string[], ...over });
  const onboard = `pnpm cli window open --onboard --expect ${OWNER}`;
  const plan = (t: { sym: string; token: string }[], over = {}) => planApprove({ wallet: OWNER, chainId: 9800, window: win(), maxFeePerGas: FEE, tokens: t, ...over });

  it("one tx per token whose allowance is not maxUint256", () => {
    expect(tokensToApprove({ fUSD: maxUint256, fETH: 0n, fBTC: 5n }, tokens)).toEqual([
      { sym: "fETH", token: fETH },
      { sym: "fBTC", token: fBTC },
    ]);
    expect(tokensToApprove({ fUSD: maxUint256, fETH: maxUint256, fBTC: maxUint256 }, tokens)).toEqual([]);
  });
  it("cost = n x approve gas at the fee cap", () => {
    const p = plan([{ sym: "fETH", token: fETH }, { sym: "fBTC", token: fBTC }]);
    expect(p.blockers).toEqual([]);
    expect(p.cost).toBe(2n * evmWindowCost({ gas: APPROVE_GAS, maxFeePerGas: FEE }));
  });
  it("needs n txs in the window", () => {
    const p = plan([{ sym: "fETH", token: fETH }, { sym: "fBTC", token: fBTC }], { window: win({ remainingTxs: 1n }) });
    expect(p.blockers.join()).toMatch(/1 tx left, 2 needed/);
    expect(p.command).toBe(onboard);
  });
  it("budget for n x 100000 gas", () => {
    const one = evmWindowCost({ gas: APPROVE_GAS, maxFeePerGas: FEE });
    const p = plan([{ sym: "fETH", token: fETH }, { sym: "fBTC", token: fBTC }], { window: win({ remainingValue: one }) });
    expect(p.blockers.join()).toMatch(/budget/);
    expect(p.command).toBe(onboard);
  });
  it("a scoped window must list every token", () => {
    const p = plan([{ sym: "fETH", token: fETH }, { sym: "fBTC", token: fBTC }], { window: win({ allowedTargets: [fETH.toUpperCase().replace("0X", "0x")] }) });
    expect(p.blockers.join()).toMatch(/fBTC/);
    expect(p.blockers.join()).not.toMatch(/fETH/);
    expect(p.command).toBe(onboard);
    expect(plan([{ sym: "fETH", token: fETH }], { window: win({ allowedTargets: [fETH] }) }).blockers).toEqual([]);
  });
  it("closed window yields the command; nothing to approve is a blocker", () => {
    expect(plan([{ sym: "fETH", token: fETH }], { window: win({ live: false }) }).command).toBe(onboard);
    const p = plan([]);
    expect(p.blockers).toEqual(["nothing to approve: the vault already has the maximum allowance"]);
    expect(p.command).toBeNull();
  });
});

describe("protect local state", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const empty = { vault: null, recovery: null, trustedReviewed: false };

  it("round-trips per owner under qday.protect.v1.<owner lowercase>", () => {
    const s = store();
    const st = { vault: VAULT, recovery: OTHER, trustedReviewed: true };
    saveProtectState(s, OWNER.toUpperCase().replace("0X", "0x"), st);
    expect([...s.m.keys()]).toEqual([`qday.protect.v1.${OWNER}`]);
    expect(loadProtectState(s, OWNER)).toEqual(st);
    expect(loadProtectState(s, OTHER)).toEqual(empty);
  });
  it("tolerates missing storage, throwing storage and malformed JSON", () => {
    expect(loadProtectState(undefined, OWNER)).toEqual(empty);
    expect(() => saveProtectState(undefined, OWNER, empty)).not.toThrow();
    const boom = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadProtectState(boom, OWNER)).toEqual(empty);
    expect(() => saveProtectState(boom, OWNER, empty)).not.toThrow();
    const s = store();
    s.m.set(`qday.protect.v1.${OWNER}`, "{nope");
    expect(loadProtectState(s, OWNER)).toEqual(empty);
  });
  it("drops invalid fields", () => {
    const s = store();
    s.m.set(`qday.protect.v1.${OWNER}`, JSON.stringify({ vault: "0x12", recovery: 5, trustedReviewed: "yes" }));
    expect(loadProtectState(s, OWNER)).toEqual(empty);
    s.m.set(`qday.protect.v1.${OWNER}`, "[1]");
    expect(loadProtectState(s, OWNER)).toEqual(empty);
  });
});

describe("recoveryWarning", () => {
  it("warns when the loaded withdrawal pays an address other than the saved recovery address", () => {
    const w = recoveryWarning(OTHER, OWNER);
    expect(w).toContain(OTHER);
    expect(w).toContain(OWNER);
  });
  it("is quiet when they match (any case) or no recovery address is saved", () => {
    expect(recoveryWarning(OWNER.toUpperCase().replace("0X", "0x"), OWNER)).toBeNull();
    expect(recoveryWarning(OTHER, null)).toBeNull();
  });
});

describe("vaultRoleProblems", () => {
  const want = { owner: OWNER, guardian: GUARDIAN };
  it("is empty only when owner and guardian both match (any case)", () => {
    expect(vaultRoleProblems({ owner: OWNER.toUpperCase().replace("0X", "0x"), guardian: GUARDIAN }, want)).toEqual([]);
  });
  it("names each role that differs", () => {
    expect(vaultRoleProblems({ owner: OTHER, guardian: GUARDIAN }, want)).toEqual([expect.stringContaining(OTHER)]);
    expect(vaultRoleProblems({ owner: OWNER, guardian: OTHER }, want)).toEqual([expect.stringContaining("guardian")]);
    expect(vaultRoleProblems({ owner: OTHER, guardian: OTHER }, want)).toHaveLength(2);
  });
});

describe("deployOffer", () => {
  const base = { vault: VAULT, vaultState: "current" as const, rolesLoaded: false, rolesError: false };
  it("offers a deploy with no vault in use", () => expect(deployOffer({ ...base, vault: null })).toBe("offer"));
  it("waits while the roles of a vault in use are loading (no second vault)", () => {
    expect(deployOffer(base)).toBe("checking");
    expect(deployOffer({ ...base, rolesLoaded: true })).toBe("checking");
  });
  it("offers again when the vault is blocked; an unreadable saved vault shows its error, never a second deploy", () => {
    expect(deployOffer({ ...base, vaultState: "blocked", rolesLoaded: true })).toBe("offer");
    expect(deployOffer({ ...base, rolesError: true })).toBe("error");
  });
  it("is done once the vault step is done", () => expect(deployOffer({ ...base, vaultState: "done", rolesLoaded: true })).toBe("done"));
});

describe("step 1 gates the vault (no vault for an owner without a proven PQC key)", () => {
  it.each([
    ["pqc not registered", { pqc: { registered: false } }],
    ["no possession proof", { pqc: { registered: true, possessionProven: false } }],
    ["wrong chain", { chainId: 1 }],
  ] as [string, Partial<ProtectInput>][])("%s: vault, approve and guardian are not done even for a matching vault", (_n, over) => {
    const r = byId(full(over));
    expect(r.vault.state).not.toBe("done");
    expect(r.vault.detail).toMatch(/^finish step 1 first: /);
    expect(r.approve.state).not.toBe("done");
    expect(r.approve.detail).toMatch(/^finish step 1 first: /);
    expect(r.guardian.state).not.toBe("done");
    expect(r.guardian.detail).toMatch(/^finish step 1 first: /);
  });
  it("loading PQC is not done either", () => {
    expect(byId(full({ pqc: undefined })).vault.state).not.toBe("done");
  });
});

describe("onboarding window", () => {
  const w = (over: Record<string, unknown>) => ({ live: true, remainingTxs: 5n, remainingValue: 1n, allowedTargets: [] as string[], ...over });
  it("onboardingWindowOpen: live and unscoped only", () => {
    expect(onboardingWindowOpen(w({}))).toBe(true);
    expect(onboardingWindowOpen(w({ allowedTargets: [VAULT] }))).toBe(false);
    expect(onboardingWindowOpen(w({ live: false }))).toBe(false);
    expect(onboardingWindowOpen(undefined)).toBe(false);
  });
  it("the guardian step is not done (so not protected) while the unscoped window is live", () => {
    const r = byId(full({ window: w({}) }));
    expect(r.guardian.state).not.toBe("done");
    expect(r.guardian.detail).toContain("pnpm cli window close --expect " + OWNER);
    expect(byId(full({ window: w({ allowedTargets: [VAULT] }) })).guardian.state).toBe("done");
  });
  it("a window still being read is not done either", () => {
    expect(byId(full({ window: undefined })).guardian.state).not.toBe("done");
  });
});

describe("ownerEnvNote", () => {
  it("names run.env, OWNER_MNEMONIC and the vault to export", () => {
    expect(ownerEnvNote(VAULT)).toBe(`Load this owner's run.env (OWNER_MNEMONIC) and export VAULT_ADDRESS=${VAULT}`);
  });
});
