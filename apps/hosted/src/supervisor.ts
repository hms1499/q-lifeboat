import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildFundMsg, loadTokens } from "@qday/core";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import type { Hex } from "viem";
import type { ChainDeps } from "./provision.ts";
import type { Store } from "./store.ts";

/** The first owner's agent listens on 127.0.0.1:9100, the next free port above for each new one. */
export const FIRST_AGENT_PORT = 9100;
/** Spec §6.6: at most 40 agents poll diana at once. */
export const MAX_AGENTS = 40;
/** An owner with no signed write and no incident for this long is retired. */
export const RETIRE_AFTER_MS = 7 * 24 * 3600 * 1000;
/** What a retired guardian keeps for the fee of its sweep (a hybrid tx costs 0.225 QOR, chain fact 21). */
export const GUARDIAN_FEE_RESERVE_UQOR = 300_000n;

const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** An agent that ran this long before it exited restarts after the first delay again. */
const HEALTHY_RUN_MS = 60_000;
/** SIGTERM, then SIGKILL after this long. */
const KILL_GRACE_MS = 5_000;

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const AGENT_DIR = join(REPO_ROOT, "apps", "agent");

/** What the supervisor needs from a spawned process (node's ChildProcess, or a fake in tests). */
export type ChildLike = {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
};

/** Milliseconds, and timers the tests can drive. */
export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type StartResult =
  | { ok: true; port: number }
  | { ok: false; reason: "not-active" | "no-secrets" | "capacity" | "refund-unavailable" | "refund-failed" };

export type SupervisorDeps = {
  spawn(env: Record<string, string>): ChildLike;
  store: Store;
  clock: Clock;
  log(line: string): void;
  /** The env every agent shares (`agentBaseEnv`): tokens, PATH, HOME, NODE_*. Per-owner values are added on top. */
  baseEnv: Record<string, string>;
  /** Send a retired owner's guardian QOR, minus its fee reserve, back to the funder. Absent: retirement keeps `sweepPending`. */
  sweep?(owner: Hex): Promise<string | null>;
  /** Top a retired owner's guardian back up before it is started again. Absent: a retired owner cannot be revived. */
  refund?(owner: Hex): Promise<unknown>;
};

type Entry = {
  owner: Hex;
  port: number;
  child?: ChildLike;
  startedAt: number;
  /** Consecutive short-lived runs: the next restart waits 1 s × 2^failures, at most 60 s. */
  failures: number;
  timer?: unknown;
  stopped: boolean;
};

const lower = (h: string) => h.toLowerCase() as Hex;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Only what an agent needs from the hosted process env: PATH, HOME, NODE_*, the test-token addresses, and an LLM key
 * only when HOSTED_AGENT_ANTHROPIC_API_KEY is set. Never FUNDER_MNEMONIC, OWNER_MNEMONIC, the builder's alert channels
 * (spec §6.8: alerts are in-app only) or the root GAS_MNEMONIC. Throws when a token address is missing or malformed.
 */
export function agentBaseEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const tokens = loadTokens(env);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === "PATH" || k === "HOME" || k.startsWith("NODE_")) out[k] = v;
  }
  out.FUSD_ADDRESS = tokens.fUSD;
  out.FETH_ADDRESS = tokens.fETH;
  out.FBTC_ADDRESS = tokens.fBTC;
  const llm = env.HOSTED_AGENT_ANTHROPIC_API_KEY?.trim();
  if (llm) out.ANTHROPIC_API_KEY = llm;
  return out;
}

/** The unchanged agent (`apps/agent/src/index.ts`) under tsx, its output prefixed with the owner. */
export function spawnAgent(log: (line: string) => void) {
  return (env: Record<string, string>): ChildLike => {
    const child = nodeSpawn(process.execPath, ["--import", "tsx", join(AGENT_DIR, "src", "index.ts")], {
      env,
      cwd: AGENT_DIR, // tsx is an agent devDependency: `--import tsx` resolves from here
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const tag = `[agent ${env.OWNER_EVM_ADDRESS?.slice(0, 10) ?? "?"}]`;
    for (const s of [child.stdout, child.stderr]) if (s) createInterface({ input: s }).on("line", (l) => log(`${tag} ${l}`));
    return child;
  };
}

/** A retired guardian's QOR minus `GUARDIAN_FEE_RESERVE_UQOR`, sent to the funder in a hybrid tx from the guardian. */
export function createGuardianSweeper(deps: {
  store: Store;
  chain: Pick<ChainDeps, "uqorBalance" | "broadcast">;
  funderCosmos: string;
  derive?(mnemonic: string): Promise<UnifiedAccount>;
}) {
  const derive = deps.derive ?? ((m: string) => deriveUnifiedAccount(m));
  return async (owner: Hex): Promise<string | null> => {
    const secrets = deps.store.readSecrets(owner);
    if (!secrets) throw new Error("no stored guardian secrets");
    let guardian: UnifiedAccount;
    try {
      guardian = await derive(secrets.GAS_MNEMONIC);
    } catch (e) {
      // Only the error name: a message could carry the mnemonic.
      throw new Error(`the stored GAS_MNEMONIC could not be used (${e instanceof Error ? e.name : "UnknownError"})`);
    }
    const balance = await deps.chain.uqorBalance(guardian.cosmos);
    if (balance <= GUARDIAN_FEE_RESERVE_UQOR) return null;
    const msg = buildFundMsg(guardian.cosmos, deps.funderCosmos, balance - GUARDIAN_FEE_RESERVE_UQOR);
    return deps.chain.broadcast(guardian, [msg], "qlifeboat: sweep retired guardian", "hybrid");
  };
}

/**
 * One unchanged agent process per active owner on 127.0.0.1:<port>. Restarts a crashed agent with backoff, resumes
 * every active owner on boot (except those stopped by a signed `stop`), retires idle ones. Logs owners and ports, never
 * a secret: the per-owner env is handed to `spawn` only.
 */
export function createSupervisor(deps: SupervisorDeps) {
  const { store, clock, log } = deps;
  const entries = new Map<Hex, Entry>();
  // Agents being stopped: a new start for the same owner waits for the old process to exit (it holds the port).
  const exiting = new Map<Hex, Promise<void>>();
  // Revive and retire for one owner never interleave.
  const locks = new Map<Hex, Promise<unknown>>();

  const withLock = <T>(o: Hex, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(o) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(o, tail);
    void tail.then(() => {
      if (locks.get(o) === tail) locks.delete(o);
    });
    return run;
  };

  /** The stored port when no other owner holds it, else the lowest port from 9100 that no owner holds. */
  const portFor = (o: Hex, stored: number | undefined): number => {
    const taken = new Set<number>();
    for (const s of store.list()) if (lower(s.owner) !== o && s.port !== undefined) taken.add(s.port);
    for (const e of entries.values()) if (e.owner !== o) taken.add(e.port);
    if (stored !== undefined && !taken.has(stored)) return stored;
    let p = FIRST_AGENT_PORT;
    while (taken.has(p)) p++;
    return p;
  };

  const launch = (e: Entry) => {
    const s = store.get(e.owner);
    const secrets = store.readSecrets(e.owner);
    if (!s || s.stage !== "active" || !s.vault || !s.guardian || !secrets) {
      entries.delete(e.owner);
      log(`agent ${e.owner}: no longer active, not restarted`);
      return;
    }
    const env: Record<string, string> = {
      ...deps.baseEnv,
      OWNER_EVM_ADDRESS: s.owner,
      VAULT_ADDRESS: s.vault,
      GUARDIAN_ADDRESS: s.guardian,
      GAS_MNEMONIC: secrets.GAS_MNEMONIC,
      AGENT_ED25519_SK: secrets.AGENT_ED25519_SK,
      AGENT_PORT: String(e.port),
      INCIDENTS_FILE: join(store.dir(e.owner), "incidents.jsonl"),
      POLL_MS: "1000",
      GUARDIAN_WINDOW_MODE: "on-demand",
      // No fire-drill runner inside a hosted agent: a drill runs demo.sh, which reads the root .env (the funder).
      DRILL: "1",
    };
    let child: ChildLike;
    try {
      child = deps.spawn(env);
    } catch (err) {
      log(`agent ${e.owner}: spawn failed: ${errorText(err)}`);
      scheduleRestart(e);
      return;
    }
    e.child = child;
    e.startedAt = clock.now();
    log(`agent ${e.owner}: started on 127.0.0.1:${e.port}`);
    const onGone = (why: string) => {
      if (e.child !== child) return; // already handled (error then exit), or an older process
      e.child = undefined;
      if (e.stopped || entries.get(e.owner) !== e) return;
      log(`agent ${e.owner}: ${why}`);
      scheduleRestart(e);
    };
    child.on("exit", (code, signal) => onGone(`exited (code ${code}, signal ${signal})`));
    child.on("error", (err) => onGone(`process error: ${errorText(err)}`));
  };

  const scheduleRestart = (e: Entry) => {
    if (clock.now() - e.startedAt >= HEALTHY_RUN_MS) e.failures = 0;
    const delay = Math.min(BACKOFF_FIRST_MS * 2 ** e.failures, BACKOFF_MAX_MS);
    e.failures++;
    log(`agent ${e.owner}: restart in ${delay} ms`);
    e.timer = clock.setTimeout(() => {
      e.timer = undefined;
      if (!e.stopped && entries.get(e.owner) === e) launch(e);
    }, delay);
  };

  /** SIGTERM, SIGKILL after the grace period; resolves once the process is gone. */
  const kill = (e: Entry): Promise<void> => {
    e.stopped = true;
    if (e.timer !== undefined) clock.clearTimeout(e.timer);
    e.timer = undefined;
    const child = e.child;
    if (!child) return Promise.resolve();
    return new Promise<void>((done) => {
      let finished = false;
      let grace: unknown;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (grace !== undefined) clock.clearTimeout(grace);
        done();
      };
      child.on("exit", finish);
      grace = clock.setTimeout(() => {
        if (finished) return;
        log(`agent ${e.owner}: no exit after SIGTERM, sending SIGKILL`);
        child.kill("SIGKILL");
        finish();
      }, KILL_GRACE_MS);
      child.kill("SIGTERM");
    });
  };

  /** Stop the owner's agent if one runs; resolves once it exited. */
  const halt = async (o: Hex): Promise<void> => {
    const e = entries.get(o);
    if (e) {
      entries.delete(o);
      const gone = kill(e).finally(() => {
        if (exiting.get(o) === gone) exiting.delete(o);
      });
      exiting.set(o, gone);
    }
    await exiting.get(o);
  };

  async function start(owner: string): Promise<StartResult> {
    const o = lower(owner);
    await exiting.get(o);
    const running = entries.get(o);
    if (running) return { ok: true, port: running.port };
    const s = store.get(o);
    if (!s || s.stage !== "active" || !s.vault || !s.guardian) return { ok: false, reason: "not-active" };
    if (!store.readSecrets(o)) return { ok: false, reason: "no-secrets" };
    if (entries.size >= MAX_AGENTS) {
      log(`agent ${o}: refused, ${MAX_AGENTS} agents already run`);
      return { ok: false, reason: "capacity" };
    }
    const port = portFor(o, s.port);
    const { stopped: _stopped, ...row } = s;
    store.put({ ...row, port });
    const e: Entry = { owner: o, port, startedAt: clock.now(), failures: 0, stopped: false };
    entries.set(o, e);
    launch(e);
    return { ok: true, port };
  }

  /** Last activity in ms: the latest signed write, or the latest incident the agent appended. */
  const lastActivity = (o: Hex, lastActiveAt: number): number => {
    const f = join(store.dir(o), "incidents.jsonl");
    return existsSync(f) ? Math.max(lastActiveAt, statSync(f).mtimeMs) : lastActiveAt;
  };

  const sweepOne = async (o: Hex): Promise<void> => {
    if (!deps.sweep) {
      log(`owner ${o}: retired, no sweep path (no funder): sweep pending`);
      return;
    }
    try {
      const tx = await deps.sweep(o);
      log(`owner ${o}: guardian swept to the funder: ${tx ?? "nothing above the fee reserve"}`);
      const f = store.get(o);
      if (f) {
        const { sweepPending: _p, ...row } = f;
        store.put(row);
      }
    } catch (err) {
      log(`owner ${o}: sweep failed, retried on the next pass: ${errorText(err)}`);
    }
  };

  return {
    start,

    /** A signed `stop`: kill the agent and keep it off on boot until a signed `arm`. */
    async stop(owner: string): Promise<void> {
      const o = lower(owner);
      const s = store.get(o);
      if (s) store.put({ ...s, stopped: true });
      await halt(o);
      log(`agent ${o}: stopped by the owner`);
    },

    /** Boot: start every active owner that was not stopped by its owner. */
    async resumeAll(): Promise<void> {
      for (const s of store.list()) {
        if (s.stage !== "active" || s.stopped) continue;
        const r = await start(s.owner);
        if (!r.ok) log(`agent ${s.owner}: not resumed (${r.reason})`);
      }
    },

    /** Owners supervised now, including any waiting for a restart. */
    running(): number {
      return entries.size;
    },

    /** The loopback port of a supervised owner's agent, undefined when none is supervised. */
    portOf(owner: string): number | undefined {
      return entries.get(lower(owner))?.port;
    },

    /**
     * Owners idle for more than 7 days (no signed write, no incident): stop the agent, mark `retired` with
     * `sweepPending`, sweep the guardian. A retired owner whose sweep failed is retried.
     */
    async retireIdle(nowUnix: number): Promise<void> {
      const cutoff = nowUnix * 1000 - RETIRE_AFTER_MS;
      for (const s of store.list()) {
        const o = lower(s.owner);
        await withLock(o, async () => {
          const cur = store.get(o);
          if (!cur) return;
          if (cur.stage === "retired" && cur.sweepPending) return sweepOne(o);
          if (cur.stage !== "active" || lastActivity(o, cur.lastActiveAt) >= cutoff) return;
          log(`owner ${o}: idle since ${new Date(cur.lastActiveAt).toISOString()}, retiring`);
          await halt(o);
          const { stopped: _s, ...row } = store.get(o) ?? cur;
          store.put({ ...row, stage: "retired", sweepPending: true });
          await sweepOne(o);
        });
      }
    },

    /** A signed `arm` on a retired owner: re-fund its guardian, make it active again, start its agent. */
    revive(owner: string): Promise<StartResult> {
      const o = lower(owner);
      return withLock(o, async (): Promise<StartResult> => {
        const s = store.get(o);
        if (!s) return { ok: false, reason: "not-active" };
        if (s.stage !== "retired") return start(o);
        if (!deps.refund) return { ok: false, reason: "refund-unavailable" };
        if (entries.size >= MAX_AGENTS) return { ok: false, reason: "capacity" };
        try {
          await deps.refund(o);
        } catch (err) {
          log(`owner ${o}: guardian re-fund failed: ${errorText(err)}`);
          return { ok: false, reason: "refund-failed" };
        }
        const { stopped: _s, sweepPending: _p, ...row } = store.get(o) ?? s;
        store.put({ ...row, stage: "active", lastActiveAt: clock.now() });
        log(`owner ${o}: revived`);
        return start(o);
      });
    },

    /** Hosted shutdown: SIGTERM every agent now (synchronous, safe in an exit handler). Rows are not marked stopped. */
    shutdown(): void {
      for (const e of entries.values()) {
        e.stopped = true;
        if (e.timer !== undefined) clock.clearTimeout(e.timer);
        e.child?.kill("SIGTERM");
      }
      entries.clear();
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
