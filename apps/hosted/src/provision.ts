import {
  assertRegisteredKey,
  buildFundMsg,
  encodeLinkProof,
  buildRegisterMsg,
  loadAgentKey,
  NETWORK,
  newAgentKeyHex,
  ruleIsExact,
  vaultAbi,
  type AgentLinkProofJson,
  type HostedStatus,
} from "@qday/core";
import { broadcastTx, publicClient, uqorBalance } from "@qday/core/chain";
import {
  clearPqcStatusCache,
  deriveUnifiedAccount,
  fetchAuthenticators,
  fetchPqcStatus,
  fetchSpendingRules,
  generateMnemonic,
  signAuthenticatorLinkEd25519,
  type AuthenticatorView,
  type PqcStatus,
  type SpendingRules,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { BaseError, bytesToHex, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Hex } from "viem";
import { cosmosOf, createOwnerAuth, type OwnerAuth, type Reply } from "./auth.ts";
import {
  DAILY_CAP,
  FUNDER_FEE_RESERVE_UQOR,
  FUNDER_FLOOR_UQOR,
  GUARDIAN_FUND_UQOR,
  REFILL_BELOW_UQOR,
  REFILLS_GLOBAL_PER_DAY,
  REFILLS_PER_DAY,
  STARTER_OWNER_UQOR,
  TOPUP_BELOW_UQOR,
  TOPUP_UQOR,
  type LimitReason,
  type Limits,
} from "./limits.ts";
import { isOwnerAddress, type OwnerSecrets, type OwnerState, type Store } from "./store.ts";
import { MAX_AGENTS } from "./supervisor.ts";

export { GUARDIAN_FUND_UQOR, STARTER_OWNER_UQOR, TOPUP_UQOR } from "./limits.ts";
export { NONCE_TTL_MS, type Reply } from "./auth.ts";

type Msg = { typeUrl: string; value: unknown };

/** Every chain read and write the provisioner makes. Tests pass fakes; `productionChainDeps` is diana. */
export type ChainDeps = {
  uqorBalance(cosmos: string): Promise<bigint>;
  /** Sign and broadcast; resolves to the tx hash once delivered, throws when the chain refuses it. */
  broadcast(acc: UnifiedAccount, msgs: Msg[], memo: string, mode: "hybrid" | "classical"): Promise<string>;
  pqcStatus(cosmos: string): Promise<PqcStatus>;
  /** The vault's roles; null when the address holds no GuardianVault (no code, or the call reverts). Throws on transport errors. */
  readVault(vault: Hex): Promise<{ owner: Hex; guardian: Hex } | null>;
  /** The account's linked keys; none for an account that never linked one. */
  authenticators(cosmos: string): Promise<AuthenticatorView[]>;
  /** The account's spending rules; none for an account that never linked a key. */
  spendingRules(cosmos: string): Promise<SpendingRules>;
  sleep(ms: number): Promise<void>;
};

export type ProvisionDeps = {
  store: Store;
  chain: ChainDeps;
  /** The account that pays starter packs, top-ups and guardian funding (FUNDER_MNEMONIC). */
  funder: UnifiedAccount;
  limits: Limits;
  /** Milliseconds. */
  now(): number;
  newMnemonic?(): string;
  /** A fresh AGENT_ED25519_SK (64 hex characters). */
  newAgentKey?(): string;
  /** Hand-off once an owner is active (Task 7: the supervisor starts its agent). */
  onActivated?(owner: Hex): void | Promise<void>;
  /** Room for one more agent (the supervisor's 40 cap). Absent: always room. */
  canStart?(): boolean;
  /** Signed-request verification; share one with the gateway so they share one replay set. Default: built from `chain`. */
  auth?: OwnerAuth;
  log?(line: string): void;
};

const STATUS_CACHE_MS = 10_000;
const DAY_MS = 24 * 3600 * 1000;
const EXPIRY_MARGIN_SECONDS = 60;
const POLL_TRIES = 20;
const POLL_DELAY_MS = 1_500;

const LIMIT_CODE: Record<LimitReason, number> = { "owner-used": 409, "ip-limit": 429, "daily-cap": 429, "funder-low": 503 };

const reply = (code: number, body: unknown): Reply => ({ code, body });
const err = (code: number, error: string): Reply => reply(code, { error });
const lower = (h: string) => h.toLowerCase() as Hex;
const norm = (h: string) => h.replace(/^0x/i, "").toLowerCase();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Derive an account from a mnemonic. Only the error name is surfaced: a message could carry the secret. */
async function deriveSecret(mnemonic: string, what: string): Promise<UnifiedAccount> {
  try {
    return await deriveUnifiedAccount(mnemonic);
  } catch (e) {
    throw new Error(`${what} could not be used to derive an account (${e instanceof Error ? e.name : "UnknownError"})`);
  }
}

/**
 * Starter packs, signed top-ups, Guardian provisioning and activation. Every funder tx goes through one queue (one
 * cosmos sequence). Logs addresses and tx hashes only, never a mnemonic or a key.
 */
export function createProvisioner(deps: ProvisionDeps) {
  const { store, chain, funder, limits } = deps;
  const log = deps.log ?? (() => {});
  const newMnemonic = deps.newMnemonic ?? (() => generateMnemonic());
  const newAgentKey = deps.newAgentKey ?? newAgentKeyHex;
  const nowSec = () => Math.floor(deps.now() / 1000);

  // One funder tx in flight at a time: they share the funder's cosmos sequence.
  let funderQueue: Promise<unknown> = Promise.resolve();
  const funderSend = (to: string, uqor: bigint, memo: string): Promise<string> => {
    const run = funderQueue.then(() => chain.broadcast(funder, [buildFundMsg(funder.cosmos, to, uqor)], memo, "hybrid"));
    funderQueue = run.catch(() => {});
    return run;
  };

  const waitFor = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> => {
    let v = await read();
    for (let i = 1; i < POLL_TRIES && !ok(v); i++) {
      await chain.sleep(POLL_DELAY_MS);
      v = await read();
    }
    if (!ok(v)) throw new Error(`timed out waiting for ${what}`);
    return v;
  };

  const auth = deps.auth ?? createOwnerAuth({ pqcStatus: (c) => chain.pqcStatus(c), now: deps.now, log });
  const authorize = auth.authorize;

  const linkProofFor = (ownerCosmos: string, secrets: OwnerSecrets): AgentLinkProofJson => {
    const agent = loadAgentKey({ AGENT_ED25519_SK: secrets.AGENT_ED25519_SK });
    const proof = signAuthenticatorLinkEd25519({ chainId: NETWORK.chainId, account: ownerCosmos, privateKey: agent.sk });
    return encodeLinkProof({ ...proof, agentPubKeyHex: bytesToHex(proof.pubkey) });
  };

  type Provisioned = { ok: true; guardian: Hex; secrets: OwnerSecrets } | { ok: false; reply: Reply };
  const inflight = new Map<string, Promise<Provisioned>>();

  /**
   * Create (or resume) the owner's guardian: secrets written BEFORE any QOR is sent, fund it to 1 QOR, register its
   * ML-DSA-87 key classically (bootstrap-exempt), wait until REST shows it. A later call reuses the stored secrets.
   */
  async function provisionGuardian(owner: Hex): Promise<Provisioned> {
    const state = store.get(owner);
    // Only an owner that took a starter pack: onboarding then sits under the starter caps (one per owner, per IP, per day).
    if (state?.starter !== true) return { ok: false, reply: err(403, "no-starter") };
    let secrets = store.readSecrets(owner);
    if (state?.guardian && secrets) return { ok: true, guardian: state.guardian, secrets };

    const funderFor = async (uqor: bigint) => (await chain.uqorBalance(funder.cosmos)) >= uqor + FUNDER_FEE_RESERVE_UQOR;
    let guardian: UnifiedAccount;
    if (!secrets) {
      // Refuse before anything is written when the funder cannot pay for the guardian.
      if (!(await funderFor(GUARDIAN_FUND_UQOR))) return { ok: false, reply: err(503, "funder-low") };
      const mnemonic = newMnemonic();
      const agentSk = newAgentKey();
      loadAgentKey({ AGENT_ED25519_SK: agentSk }); // format check; never echoes the key
      guardian = await deriveSecret(mnemonic, "the generated guardian mnemonic");
      if ([funder.cosmos, cosmosOf(owner)].includes(guardian.cosmos)) throw new Error("the generated guardian is the funder or the owner");
      secrets = { GAS_MNEMONIC: mnemonic, AGENT_ED25519_SK: agentSk };
      store.writeSecrets(owner, secrets);
      log(`owner ${owner}: new guardian ${guardian.evm} (${guardian.cosmos})`);
    } else {
      guardian = await deriveSecret(secrets.GAS_MNEMONIC, "the stored GAS_MNEMONIC");
      log(`owner ${owner}: resuming guardian ${guardian.evm}`);
    }

    let status = await chain.pqcStatus(guardian.cosmos);
    if (!status.registered) {
      const balance = await chain.uqorBalance(guardian.cosmos);
      if (balance < GUARDIAN_FUND_UQOR) {
        const amount = GUARDIAN_FUND_UQOR - balance;
        if (!(await funderFor(amount))) return { ok: false, reply: err(503, "funder-low") };
        const fundTx = await funderSend(guardian.cosmos, amount, "qlifeboat: fund guardian");
        log(`owner ${owner}: fund guardian ${amount} uqor: ${fundTx}`);
        await waitFor(() => chain.uqorBalance(guardian.cosmos), (b) => b >= GUARDIAN_FUND_UQOR, "the guardian's balance");
      }
      const regTx = await chain.broadcast(guardian, [buildRegisterMsg(guardian, NETWORK.chainId)], "qlifeboat: register guardian ML-DSA-87 key", "classical");
      log(`owner ${owner}: register guardian ML-DSA-87 key: ${regTx}`);
      status = await waitFor(() => chain.pqcStatus(guardian.cosmos), (s) => s.registered, "the guardian's PQC registration to show on REST");
    }
    assertRegisteredKey(status, guardian.pqc.publicKey);

    const now = deps.now();
    const base: OwnerState = store.get(owner) ?? state;
    store.put({ ...base, stage: base.stage === "starter" ? "provisioned" : base.stage, guardian: guardian.evm as Hex, lastActiveAt: now });
    return { ok: true, guardian: guardian.evm as Hex, secrets };
  }

  let statusCache: { at: number; value: HostedStatus } | null = null;
  // One refill per owner at a time (two arms at once share it).
  const refilling = new Map<Hex, Promise<{ tx: string } | { skipped: "enough" | "daily-cap" | "funder-low" | "not-provisioned" }>>();

  return {
    /** `POST /api/starter` `{ owner }`: unsigned (the account has no key yet), capped by `limits`. */
    async starter(ip: string, body: unknown): Promise<Reply> {
      const owner = (body as { owner?: unknown } | null)?.owner;
      if (typeof owner !== "string" || !isOwnerAddress(owner)) return err(400, "invalid owner address");
      const o = lower(owner);
      let funderUqor: bigint;
      try {
        funderUqor = await chain.uqorBalance(funder.cosmos);
      } catch (e) {
        log(`funder balance unreadable: ${errorText(e)}`);
        return err(502, "chain unreachable");
      }
      // Synchronous from here to record: a concurrent request for the same owner sees it.
      if (store.get(o)) return err(409, "owner-used");
      const c = limits.check(ip, o, funderUqor);
      if (!c.ok) return err(LIMIT_CODE[c.reason], c.reason);
      limits.record(ip, o);
      let tx: string;
      try {
        tx = await funderSend(cosmosOf(o), STARTER_OWNER_UQOR, "qlifeboat: starter pack");
      } catch (e) {
        limits.undo(ip, o);
        log(`starter for ${o} failed: ${errorText(e)}`);
        return err(502, "starter tx failed");
      }
      const now = deps.now();
      const existing = store.get(o);
      store.put(existing ? { ...existing, starter: true } : { owner: o, stage: "starter", starter: true, createdAt: now, lastActiveAt: now, topups: 0 });
      log(`starter ${STARTER_OWNER_UQOR} uqor to ${o}: ${tx}`);
      return reply(200, { tx });
    },

    /** `POST /api/topup`, signed `topup`: 1 QOR once, only while the owner holds less than 0.5 QOR. */
    async topup(x: unknown): Promise<Reply> {
      const a = await authorize(x, "topup");
      if (!a.ok) return a.reply;
      const first = store.get(a.owner);
      if (!first) return err(404, "unknown owner");
      if (first.starter !== true) return err(403, "no-starter");
      if (first.topups > 0) return err(409, "topup-used");
      try {
        if ((await chain.uqorBalance(a.ownerCosmos)) >= TOPUP_BELOW_UQOR) return err(409, "balance-sufficient");
        if ((await chain.uqorBalance(funder.cosmos)) < TOPUP_UQOR + FUNDER_FEE_RESERVE_UQOR) return err(503, "funder-low");
      } catch (e) {
        log(`topup reads for ${a.owner} failed: ${errorText(e)}`);
        return err(502, "chain unreachable");
      }
      // Re-read after the awaits and claim the top-up before sending: a concurrent request then sees topups > 0.
      const state = store.get(a.owner);
      if (!state || state.starter !== true || state.topups > 0) return err(409, "topup-used");
      store.put({ ...state, topups: state.topups + 1, lastActiveAt: deps.now() });
      try {
        const tx = await funderSend(a.ownerCosmos, TOPUP_UQOR, "qlifeboat: owner top-up");
        log(`topup ${TOPUP_UQOR} uqor to ${a.owner}: ${tx}`);
        return reply(200, { tx });
      } catch (e) {
        const s = store.get(a.owner);
        if (s) store.put({ ...s, topups: Math.max(0, s.topups - 1) });
        log(`topup for ${a.owner} failed: ${errorText(e)}`);
        return err(502, "topup tx failed");
      }
    },

    /**
     * `POST /api/onboard`, signed `onboard` → `{ guardian, linkProof }`. Idempotent per owner: a later call returns the
     * stored guardian and a fresh proof; concurrent first calls share one provisioning.
     */
    async onboard(x: unknown): Promise<Reply> {
      const a = await authorize(x, "onboard");
      if (!a.ok) return a.reply;
      let run = inflight.get(a.owner);
      // At agent capacity no NEW guardian is made or funded (activate would refuse it); an owner whose guardian exists
      // (secrets written, even half-provisioned) still resumes and gets its proof.
      if (!run && !store.readSecrets(a.owner) && deps.canStart && !deps.canStart()) return err(503, "capacity");
      if (!run) {
        run = provisionGuardian(a.owner)
          .catch((e): Provisioned => {
            log(`provisioning for ${a.owner} failed: ${errorText(e)}`);
            return { ok: false, reply: err(502, "guardian provisioning failed") };
          })
          .finally(() => inflight.delete(a.owner));
        inflight.set(a.owner, run);
      }
      const p = await run;
      if (!p.ok) return p.reply;
      return reply(200, { guardian: p.guardian, linkProof: linkProofFor(a.ownerCosmos, p.secrets) });
    },

    /**
     * `POST /api/activate`, signed `activate` `{ vault }`: on chain, `owner()` is the owner, `guardian()` the stored
     * guardian, the agent key is linked and live, and the rule is exactly `vault.rescue` + uqor. Then stage `active`
     * and the hand-off.
     */
    async activate(x: unknown): Promise<Reply> {
      const a = await authorize(x, "activate");
      if (!a.ok) return a.reply;
      const vault = (a.body as { vault?: unknown } | null)?.vault;
      if (typeof vault !== "string" || !isOwnerAddress(vault)) return err(400, "invalid vault address");
      const v = lower(vault);
      const state = store.get(a.owner);
      const secrets = store.readSecrets(a.owner);
      if (!state?.guardian || !secrets) return err(409, "not-provisioned");
      // Idempotent: the same vault again is a no-op (no second hand-off); another vault needs the owner to stop first.
      if (state.stage === "active") return state.vault === v ? reply(200, { ok: true }) : err(409, "already-active");
      let roles: { owner: Hex; guardian: Hex } | null;
      try {
        roles = await chain.readVault(v);
      } catch (e) {
        log(`vault ${v} read failed: ${errorText(e)}`);
        return err(502, "chain-unavailable");
      }
      if (!roles) return err(409, "vault-unreadable");
      if (lower(roles.owner) !== a.owner) return err(409, "vault-owner-mismatch");
      if (lower(roles.guardian) !== lower(state.guardian)) return err(409, "vault-guardian-mismatch");
      let auths: AuthenticatorView[];
      let rules: SpendingRules;
      try {
        [auths, rules] = await Promise.all([chain.authenticators(a.ownerCosmos), chain.spendingRules(a.ownerCosmos)]);
      } catch (e) {
        log(`link reads for ${a.owner} failed: ${errorText(e)}`);
        return err(502, "chain unreachable");
      }
      const want = norm(bytesToHex(loadAgentKey({ AGENT_ED25519_SK: secrets.AGENT_ED25519_SK }).pk));
      const minExpiry = BigInt(nowSec() + EXPIRY_MARGIN_SECONDS);
      if (!auths.some((k) => !k.revoked && norm(k.pubkeyHex) === want && k.expiryUnix > minExpiry)) return err(409, "agent-not-linked");
      if (!ruleIsExact(rules, v)) return err(409, "rule-not-exact");
      const fresh = store.get(a.owner) ?? state;
      if (fresh.stage === "active") return fresh.vault === v ? reply(200, { ok: true }) : err(409, "already-active");
      // At capacity the owner stays provisioned (and can retry) rather than be marked active with no agent watching.
      if (deps.canStart && !deps.canStart()) return err(503, "capacity");
      store.put({ ...fresh, stage: "active", vault: v, lastActiveAt: deps.now() });
      log(`owner ${a.owner}: active with vault ${v}`);
      try {
        await deps.onActivated?.(a.owner);
      } catch (e) {
        log(`hand-off for ${a.owner} failed: ${errorText(e)}`);
      }
      return reply(200, { ok: true });
    },

    /**
     * Top a retired owner's guardian back up to `GUARDIAN_FUND_UQOR` (retirement swept it down to its fee reserve), in
     * the funder queue. Resolves to the tx hash, or null when the guardian already holds enough. Throws "not-provisioned"
     * or "funder-low".
     */
    async refundGuardian(owner: Hex): Promise<string | null> {
      const o = lower(owner);
      const secrets = store.readSecrets(o);
      if (!store.get(o)?.guardian || !secrets) throw new Error("not-provisioned");
      const guardian = await deriveSecret(secrets.GAS_MNEMONIC, "the stored GAS_MNEMONIC");
      const balance = await chain.uqorBalance(guardian.cosmos);
      if (balance >= GUARDIAN_FUND_UQOR) return null;
      const amount = GUARDIAN_FUND_UQOR - balance;
      if ((await chain.uqorBalance(funder.cosmos)) < amount + FUNDER_FEE_RESERVE_UQOR) throw new Error("funder-low");
      const tx = await funderSend(guardian.cosmos, amount, "qlifeboat: re-fund guardian");
      log(`owner ${o}: re-fund guardian ${amount} uqor: ${tx}`);
      await waitFor(() => chain.uqorBalance(guardian.cosmos), (b) => b >= GUARDIAN_FUND_UQOR, "the guardian's balance");
      return tx;
    },

    /**
     * Before a signed `arm` reaches the agent: an on-demand guardian spends ~0.225 QOR per owner session (its window)
     * plus rescue gas, so below `REFILL_BELOW_UQOR` it is topped back up to `GUARDIAN_FUND_UQOR` from the funder. At most
     * `REFILLS_PER_DAY` per owner and `REFILLS_GLOBAL_PER_DAY` overall per UTC day, never below the funder floor (starter packs keep priority). Concurrent
     * calls for one owner share one refill. Never throws for a skip; a failed send throws.
     */
    refillOnArm(owner: Hex): Promise<{ tx: string } | { skipped: "enough" | "daily-cap" | "funder-low" | "not-provisioned" }> {
      const o = lower(owner);
      const running = refilling.get(o);
      if (running) return running;
      const run = (async (): Promise<{ tx: string } | { skipped: "enough" | "daily-cap" | "funder-low" | "not-provisioned" }> => {
        const secrets = store.readSecrets(o);
        if (!store.get(o)?.guardian || !secrets) return { skipped: "not-provisioned" };
        const guardian = await deriveSecret(secrets.GAS_MNEMONIC, "the stored GAS_MNEMONIC");
        const balance = await chain.uqorBalance(guardian.cosmos);
        if (balance >= REFILL_BELOW_UQOR) return { skipped: "enough" };
        const day = Math.floor(deps.now() / DAY_MS);
        const s = store.get(o)!;
        const used = s.refills?.day === day ? s.refills.n : 0;
        if (used >= REFILLS_PER_DAY) return { skipped: "daily-cap" };
        const today = () => store.list().reduce((sum, r) => sum + (r.refills?.day === day ? r.refills.n : 0), 0);
        if (today() >= REFILLS_GLOBAL_PER_DAY) return { skipped: "daily-cap" };
        const amount = GUARDIAN_FUND_UQOR - balance;
        // Starter packs keep priority: the refill must leave the funder at or above its floor.
        if ((await chain.uqorBalance(funder.cosmos)) < FUNDER_FLOOR_UQOR + amount + FUNDER_FEE_RESERVE_UQOR) return { skipped: "funder-low" };
        // Counted again after the funder read (another owner may have refilled meanwhile), then recorded before the send
        // (a send that fails still uses one of the day's refills): retries cannot bypass either cap.
        if (today() >= REFILLS_GLOBAL_PER_DAY) return { skipped: "daily-cap" };
        store.put({ ...(store.get(o) ?? s), refills: { day, n: used + 1 } });
        const tx = await funderSend(guardian.cosmos, amount, "qlifeboat: refill guardian");
        log(`owner ${o}: refill guardian ${amount} uqor (${used + 1}/${REFILLS_PER_DAY} today): ${tx}`);
        await waitFor(() => chain.uqorBalance(guardian.cosmos), (b) => b >= GUARDIAN_FUND_UQOR, "the guardian's balance");
        return { tx };
      })().finally(() => refilling.delete(o));
      refilling.set(o, run);
      return run;
    },

    /** `GET /api/status`: paused at agent capacity, below the funder floor or at the daily cap, so the landing page blocks before step 1. */
    async status(): Promise<HostedStatus> {
      const now = deps.now();
      if (statusCache && now - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
      const active = store.list().filter((o) => o.stage === "active");
      const activeGuardians = active.length;
      let value: HostedStatus;
      // A stopped owner runs no agent; the 40 cap counts the ones that do (or will on boot).
      if (active.filter((o) => !o.stopped).length >= MAX_AGENTS) {
        value = { onboarding: "paused", reason: "capacity", activeGuardians };
        statusCache = { at: now, value };
        return value;
      }
      try {
        const funderUqor = await chain.uqorBalance(funder.cosmos);
        if (funderUqor < FUNDER_FLOOR_UQOR) value = { onboarding: "paused", reason: "funder-low", activeGuardians };
        else if (limits.todayCount() >= DAILY_CAP) value = { onboarding: "paused", reason: "daily-cap", activeGuardians };
        else value = { onboarding: "open", activeGuardians };
      } catch {
        return { onboarding: "paused", reason: "chain-unreachable", activeGuardians };
      }
      statusCache = { at: now, value };
      return value;
    },
  };
}

export type Provisioner = ReturnType<typeof createProvisioner>;

/** True only for diana's abstractaccount REST 404 for an account that never linked a key (as apps/cli/src/abstractaccount.ts). */
export function isAccountNotFound(e: unknown, address: string): boolean {
  if (!(e instanceof Error)) return false;
  const esc = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^abstractaccount query failed: HTTP 404 from \\S+: account ${esc} not found$`).test(e.message);
}

async function orEmptyIfNoAccount<T>(read: Promise<T>, address: string, empty: T): Promise<T> {
  try {
    return await read;
  } catch (e) {
    if (isAccountNotFound(e, address)) return empty;
    throw e;
  }
}

/** Diana wiring for `ChainDeps`. */
export function productionChainDeps(): ChainDeps {
  return {
    uqorBalance,
    broadcast: async (acc, msgs, memo, mode) => (await broadcastTx(acc, msgs, memo, { signMode: mode })).transactionHash,
    pqcStatus: (cosmos) => {
      clearPqcStatusCache(); // a cached "not registered" answer would hide a new registration
      return fetchPqcStatus({ rest: NETWORK.rest, address: cosmos });
    },
    readVault: async (vault) => {
      try {
        const [owner, guardian] = await Promise.all([
          publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }),
          publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" }),
        ]);
        return { owner: owner as Hex, guardian: guardian as Hex };
      } catch (e) {
        // The node answered: no code at the address (zero data) or the call reverted. Anything else is transport.
        if (e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionZeroDataError || c instanceof ContractFunctionRevertedError)) return null;
        throw e;
      }
    },
    authenticators: (c) => orEmptyIfNoAccount(fetchAuthenticators({ rest: NETWORK.rest, address: c }), c, []),
    spendingRules: (c) => orEmptyIfNoAccount(fetchSpendingRules({ rest: NETWORK.rest, address: c }), c, { rules: [], authenticatorRules: [] }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** The funder from FUNDER_MNEMONIC, or null when it is not set (onboarding then stays paused). */
export async function loadFunder(env: Record<string, string | undefined> = process.env): Promise<UnifiedAccount | null> {
  const m = env.FUNDER_MNEMONIC?.trim();
  return m ? deriveSecret(m, "FUNDER_MNEMONIC") : null;
}
