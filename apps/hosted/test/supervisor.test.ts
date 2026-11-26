import { EventEmitter } from "node:events";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { agentBaseEnv, createGuardianSweeper, createSupervisor, GUARDIAN_FEE_RESERVE_UQOR, FIRST_AGENT_PORT, MAX_AGENTS, maxAgentsFromEnv, RETIRE_AFTER_MS, type ChildLike, type Clock } from "../src/supervisor.ts";
import { createStore, type OwnerState, type Store } from "../src/store.ts";

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 25, 12);
const owner = (i: number) => (`0x${i.toString(16).padStart(40, "0")}`) as Hex;
const VAULT = ("0x" + "77".repeat(20)) as Hex;
const GUARD = ("0x" + "66".repeat(20)) as Hex;
const BASE_ENV = { PATH: "/usr/bin", FUSD_ADDRESS: "0x" + "a1".repeat(20), FETH_ADDRESS: "0x" + "a2".repeat(20), FBTC_ADDRESS: "0x" + "a3".repeat(20) };

class FakeChild extends EventEmitter implements ChildLike {
  killed: string[] = [];
  constructor(readonly env: Record<string, string>) {
    super();
  }
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? "SIGTERM");
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
  crash() {
    this.emit("exit", 1, null);
  }
}

/** Timers run only when the test advances the clock. */
function fakeClock(start = T0): Clock & { advance(ms: number): void; pending(): number[] } {
  let t = start;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.push({ at: t + ms, fn, id: ++id });
      return id;
    },
    clearTimeout: (h) => {
      timers = timers.filter((x) => x.id !== h);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
    pending: () => timers.map((x) => x.at - t),
  };
}

function activeRow(o: Hex, over: Partial<OwnerState> = {}): OwnerState {
  return { owner: o, stage: "active", starter: true, guardian: GUARD, vault: VAULT, createdAt: T0, lastActiveAt: T0, topups: 0, ...over };
}

function setup(opts: { sweep?: (o: Hex) => Promise<string | null>; refund?: (o: Hex) => Promise<void>; maxAgents?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sup-"));
  const store: Store = createStore(dir);
  const clock = fakeClock();
  const children: FakeChild[] = [];
  const spawnAt: number[] = [];
  const logs: string[] = [];
  const sup = createSupervisor({
    spawn: (env) => {
      const c = new FakeChild(env);
      children.push(c);
      spawnAt.push(clock.now());
      return c;
    },
    store,
    clock,
    log: (l) => logs.push(l),
    baseEnv: BASE_ENV,
    sweep: opts.sweep ? (o) => opts.sweep!(o) : undefined,
    refund: opts.refund,
    maxAgents: opts.maxAgents,
  });
  const seed = (o: Hex, over: Partial<OwnerState> = {}) => {
    store.put(activeRow(o, over));
    store.writeSecrets(o, { GAS_MNEMONIC: `mnemonic ${o}`, AGENT_ED25519_SK: "22".repeat(32) });
  };
  return { sup, store, clock, children, spawnAt, logs, seed, dir };
}

describe("supervisor", () => {
  it("resumeAll starts every active owner on its stored port", async () => {
    const { sup, store, children, seed } = setup();
    seed(owner(1), { port: 9105 });
    seed(owner(2), { port: 9100 });
    seed(owner(3)); // active, no port yet: gets the lowest free one
    seed(owner(4), { stage: "retired", port: 9101 });
    seed(owner(5), { stopped: true, port: 9102 });
    store.put({ owner: owner(6), stage: "provisioned", createdAt: T0, lastActiveAt: T0, topups: 0 });
    await sup.resumeAll();
    expect(sup.running()).toBe(3);
    const byOwner = new Map(children.map((c) => [c.env.OWNER_EVM_ADDRESS, c.env]));
    expect(byOwner.get(owner(1))?.AGENT_PORT).toBe("9105");
    expect(byOwner.get(owner(2))?.AGENT_PORT).toBe("9100");
    // A stored port stays reserved for its owner (retired 9101, stopped 9102 too): owner 3 gets the lowest free one.
    expect(byOwner.get(owner(3))?.AGENT_PORT).toBe("9103");
    expect(store.get(owner(3))?.port).toBe(9103);
    expect(byOwner.has(owner(4))).toBe(false);
    expect(byOwner.has(owner(5))).toBe(false);
    expect(byOwner.has(owner(6))).toBe(false);
  });

  it("builds the agent env from scratch: owner, vault, tokens, secrets, port, incidents file, poll, on-demand", async () => {
    const { sup, children, seed, dir } = setup();
    seed(owner(1), { port: 9100 });
    expect((await sup.start(owner(1))).ok).toBe(true);
    const env = children[0]!.env;
    expect(env).toEqual({
      ...BASE_ENV,
      OWNER_EVM_ADDRESS: owner(1),
      VAULT_ADDRESS: VAULT,
      GUARDIAN_ADDRESS: GUARD,
      GAS_MNEMONIC: `mnemonic ${owner(1)}`,
      AGENT_ED25519_SK: "22".repeat(32),
      AGENT_PORT: "9100",
      INCIDENTS_FILE: join(dir, "owners", owner(1), "incidents.jsonl"),
      POLICY_FILE: join(dir, "owners", owner(1), "policy.json"),
      POLL_MS: "1000",
      GUARDIAN_WINDOW_MODE: "on-demand",
      DRILL: "1",
    });
  });

  it("agentBaseEnv keeps PATH, HOME, NODE_* and the tokens only, never the funder or alert secrets", () => {
    const tok = { FUSD_ADDRESS: BASE_ENV.FUSD_ADDRESS, FETH_ADDRESS: BASE_ENV.FETH_ADDRESS, FBTC_ADDRESS: BASE_ENV.FBTC_ADDRESS };
    const env = agentBaseEnv({
      PATH: "/bin", HOME: "/h", NODE_ENV: "production", ...tok,
      FUNDER_MNEMONIC: "secret", OWNER_MNEMONIC: "secret", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "2",
      ALERT_WEBHOOK_URL: "https://x", ANTHROPIC_API_KEY: "builder-key", GAS_MNEMONIC: "root guardian",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", NODE_ENV: "production", ...tok });
    expect(agentBaseEnv({ PATH: "/bin", ...tok, HOSTED_AGENT_ANTHROPIC_API_KEY: "k" }).ANTHROPIC_API_KEY).toBe("k");
    expect(() => agentBaseEnv({ PATH: "/bin", FUSD_ADDRESS: tok.FUSD_ADDRESS })).toThrow(/FETH_ADDRESS/);
  });

  it("a crashing agent is restarted with growing delay", async () => {
    const { sup, clock, children, spawnAt, seed } = setup();
    seed(owner(1), { port: 9100 });
    await sup.start(owner(1));
    // Each crash happens right after its spawn: the restarts run at +1 s, +2 s, +4 s.
    children.at(-1)!.crash();
    expect(children.length).toBe(1);
    clock.advance(1000);
    expect(children.length).toBe(2);
    children.at(-1)!.crash();
    clock.advance(1999);
    expect(children.length).toBe(2);
    clock.advance(1);
    expect(children.length).toBe(3);
    children.at(-1)!.crash();
    clock.advance(4000);
    expect(children.length).toBe(4);
    expect(spawnAt.map((t) => t - T0)).toEqual([0, 1000, 3000, 7000]);
    // Same port on every restart.
    expect(new Set(children.map((c) => c.env.AGENT_PORT))).toEqual(new Set(["9100"]));
    expect(sup.running()).toBe(1);
  });

  it("the restart delay is capped at 60 s and resets after a long healthy run", async () => {
    const { sup, clock, children, seed } = setup();
    seed(owner(1));
    await sup.start(owner(1));
    for (let i = 0; i < 8; i++) {
      children.at(-1)!.crash();
      clock.advance(60_000);
    }
    expect(children.length).toBe(9); // 1,2,4,…,64→60 s: every crash restarted within 60 s
    clock.advance(10 * 60_000); // healthy for 10 min
    children.at(-1)!.crash();
    clock.advance(1000);
    expect(children.length).toBe(10);
  });

  it("a configured cap (HOSTED_MAX_AGENTS) refuses the start past it, and canStart follows it", async () => {
    const { sup, seed } = setup({ maxAgents: 2 });
    for (let i = 1; i <= 3; i++) seed(owner(i));
    expect(sup.canStart()).toBe(false); // 3 active rows already hold more than 2 slots
    for (let i = 1; i <= 2; i++) expect((await sup.start(owner(i))).ok).toBe(true);
    expect(await sup.start(owner(3))).toEqual({ ok: false, reason: "capacity" });
    expect(await sup.revive(owner(4))).toEqual({ ok: false, reason: "not-active" });
    expect(sup.running()).toBe(2);
  });

  it("41st start is refused", async () => {
    const { sup, seed } = setup();
    for (let i = 1; i <= MAX_AGENTS + 1; i++) seed(owner(i));
    for (let i = 1; i <= MAX_AGENTS; i++) expect((await sup.start(owner(i))).ok).toBe(true);
    expect(sup.running()).toBe(40);
    expect(await sup.start(owner(MAX_AGENTS + 1))).toEqual({ ok: false, reason: "capacity" });
    expect(sup.running()).toBe(40);
    // Starting one that already runs is not a new agent.
    expect((await sup.start(owner(1))).ok).toBe(true);
  });

  it("refuses an owner that is not active or has no secrets", async () => {
    const { sup, store } = setup();
    store.put({ owner: owner(1), stage: "provisioned", createdAt: T0, lastActiveAt: T0, topups: 0 });
    expect(await sup.start(owner(1))).toEqual({ ok: false, reason: "not-active" });
    store.put(activeRow(owner(2)));
    expect(await sup.start(owner(2))).toEqual({ ok: false, reason: "no-secrets" });
  });

  it("stop kills the agent, never restarts it, and marks the row stopped so resumeAll skips it", async () => {
    const { sup, store, clock, children, seed } = setup();
    seed(owner(1), { port: 9100 });
    await sup.start(owner(1));
    await sup.stop(owner(1));
    expect(children[0]!.killed).toEqual(["SIGTERM"]);
    clock.advance(120_000);
    expect(children.length).toBe(1);
    expect(sup.running()).toBe(0);
    expect(store.get(owner(1))).toMatchObject({ stage: "active", stopped: true, port: 9100 });
    await sup.resumeAll();
    expect(children.length).toBe(1);
    // An explicit start (a signed arm) clears the flag and reuses the port.
    expect(await sup.start(owner(1))).toEqual({ ok: true, port: 9100 });
    expect(store.get(owner(1))?.stopped).toBeUndefined();
  });

  it("stop during a restart backoff cancels the pending restart", async () => {
    const { sup, clock, children, seed } = setup();
    seed(owner(1));
    await sup.start(owner(1));
    children[0]!.crash();
    await sup.stop(owner(1));
    clock.advance(10_000);
    expect(children.length).toBe(1);
  });

  it("shutdown kills every child without marking rows stopped", async () => {
    const { sup, store, children, seed } = setup();
    seed(owner(1));
    seed(owner(2));
    await sup.resumeAll();
    sup.shutdown();
    expect(children.every((c) => c.killed.includes("SIGTERM"))).toBe(true);
    expect(store.get(owner(1))?.stopped).toBeUndefined();
  });

  it("retireIdle stops and sweeps an owner idle 7 days, keeps one idle 6 days", async () => {
    const swept: Hex[] = [];
    const { sup, store, children, seed } = setup({ sweep: async (o) => (swept.push(o), "SWEEPTX") });
    seed(owner(1), { lastActiveAt: T0 - 7 * DAY - 1000 });
    seed(owner(2), { lastActiveAt: T0 - 6 * DAY });
    await sup.resumeAll();
    expect(RETIRE_AFTER_MS).toBe(7 * DAY);
    await sup.retireIdle(Math.floor(T0 / 1000));
    expect(swept).toEqual([owner(1)]);
    expect(store.get(owner(1))?.stage).toBe("retired");
    expect(store.get(owner(1))?.sweepPending).toBeUndefined();
    expect(store.get(owner(2))?.stage).toBe("active");
    const c1 = children.find((c) => c.env.OWNER_EVM_ADDRESS === owner(1))!;
    expect(c1.killed).toEqual(["SIGTERM"]);
    expect(sup.running()).toBe(1);
  });

  it("retireIdle counts a recent incident as activity", async () => {
    const swept: Hex[] = [];
    const { sup, store, seed, dir } = setup({ sweep: async (o) => (swept.push(o), "TX") });
    seed(owner(1), { lastActiveAt: T0 - 8 * DAY });
    const f = join(dir, "owners", owner(1), "incidents.jsonl");
    writeFileSync(f, "{}\n");
    utimesSync(f, (T0 - 2 * DAY) / 1000, (T0 - 2 * DAY) / 1000);
    await sup.retireIdle(Math.floor(T0 / 1000));
    expect(swept).toEqual([]);
    expect(store.get(owner(1))?.stage).toBe("active");
  });

  it("a failed sweep leaves the owner retired with sweepPending, retried on the next pass", async () => {
    let fail = true;
    const swept: Hex[] = [];
    const { sup, store, seed } = setup({
      sweep: async (o) => {
        if (fail) throw new Error("chain down");
        swept.push(o);
        return "TX";
      },
    });
    seed(owner(1), { lastActiveAt: T0 - 8 * DAY });
    await sup.retireIdle(Math.floor(T0 / 1000));
    expect(store.get(owner(1))).toMatchObject({ stage: "retired", sweepPending: true });
    fail = false;
    await sup.retireIdle(Math.floor(T0 / 1000));
    expect(swept).toEqual([owner(1)]);
    expect(store.get(owner(1))?.sweepPending).toBeUndefined();
  });

  it("revive re-funds a retired owner's guardian, makes it active and starts it on its old port", async () => {
    const refunded: Hex[] = [];
    const { sup, store, children, seed } = setup({ refund: async (o) => void refunded.push(o) });
    seed(owner(1), { stage: "retired", port: 9104 });
    const r = await sup.revive(owner(1));
    expect(r).toEqual({ ok: true, port: 9104 });
    expect(refunded).toEqual([owner(1)]);
    expect(store.get(owner(1))).toMatchObject({ stage: "active", port: 9104 });
    expect(children.length).toBe(1);
  });

  it("revive refuses without a refund path", async () => {
    const { sup, seed } = setup();
    seed(owner(1), { stage: "retired" });
    expect(await sup.revive(owner(1))).toEqual({ ok: false, reason: "refund-unavailable" });
  });

  it("an arm (revive) concurrent with retireIdle never leaves a running agent on a retired row", async () => {
    for (const reviveFirst of [false, true]) {
      const { sup, store, seed } = setup({
        sweep: async () => (await new Promise((r) => setTimeout(r, 5)), "TX"),
        refund: async () => void (await new Promise((r) => setTimeout(r, 5))),
      });
      seed(owner(1), { lastActiveAt: T0 - 8 * DAY, stopped: true, port: 9100 });
      const now = Math.floor(T0 / 1000);
      const both = reviveFirst ? [sup.revive(owner(1)), sup.retireIdle(now)] : [sup.retireIdle(now), sup.revive(owner(1))];
      await Promise.all(both);
      const row = store.get(owner(1))!;
      const runs = sup.portOf(owner(1)) !== undefined;
      expect(row.stage === "retired" ? !runs : runs).toBe(true);
    }
  });

  it("boot retires idle owners before resuming, so an idle owner's agent never starts", async () => {
    const swept: Hex[] = [];
    const { sup, store, children, seed } = setup({ sweep: async (o) => (swept.push(o), "TX") });
    seed(owner(1), { lastActiveAt: T0 - 8 * DAY });
    seed(owner(2));
    await sup.boot(Math.floor(T0 / 1000));
    expect(children.map((c) => c.env.OWNER_EVM_ADDRESS)).toEqual([owner(2)]);
    expect(store.get(owner(1))?.stage).toBe("retired");
    expect(swept).toEqual([owner(1)]);
  });

  it("boot resumes agents without waiting for sweeps; idle owners are retired (sweep pending) first", async () => {
    let sweeps = 0;
    const { sup, store, children, seed } = setup({ sweep: () => (sweeps++, new Promise<string | null>(() => {})) }); // a hung chain
    seed(owner(1), { lastActiveAt: T0 - 8 * DAY });
    seed(owner(2));
    store.put({ ...activeRow(owner(3)), stage: "retired", sweepPending: true });
    await sup.boot(Math.floor(T0 / 1000));
    expect(children.map((c) => c.env.OWNER_EVM_ADDRESS)).toEqual([owner(2)]);
    expect(store.get(owner(1))).toMatchObject({ stage: "retired", sweepPending: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(sweeps).toBe(2); // both sweeps started in the background
  });

  it("a hung sweep is not started again by the next pass", async () => {
    let sweeps = 0;
    const { sup, store } = setup({ sweep: () => (sweeps++, new Promise<string | null>(() => {})) });
    store.put({ ...activeRow(owner(1)), stage: "retired", sweepPending: true });
    const now = Math.floor(T0 / 1000);
    void sup.retireIdle(now);
    await new Promise((r) => setTimeout(r, 0));
    await sup.retireIdle(now); // resolves: the hung owner is skipped, not queued behind its lock
    expect(sweeps).toBe(1);
  });

  it("start and revive refuse a 41st active, non-stopped owner even when one of the 40 has no running agent", async () => {
    const { sup, store, seed } = setup({ refund: async () => {} });
    for (let i = 1; i <= MAX_AGENTS; i++) seed(owner(i)); // 40 active rows, no agent started yet
    seed(owner(100), { stopped: true });
    expect(await sup.start(owner(100))).toEqual({ ok: false, reason: "capacity" });
    seed(owner(101), { stage: "retired" });
    expect(await sup.revive(owner(101))).toEqual({ ok: false, reason: "capacity" });
    expect(store.get(owner(101))?.stage).toBe("retired");
  });

  it("canStart counts active, non-stopped owners in the store, even before their agents start", () => {
    const { sup, seed } = setup();
    for (let i = 1; i < MAX_AGENTS; i++) seed(owner(i));
    seed(owner(100), { stopped: true });
    seed(owner(101), { stage: "retired" });
    expect(sup.canStart()).toBe(true);
    seed(owner(MAX_AGENTS));
    expect(sup.canStart()).toBe(false);
  });

  it("canStart is false at 40 supervised agents", async () => {
    const { sup, seed } = setup();
    for (let i = 1; i <= MAX_AGENTS; i++) seed(owner(i));
    await sup.resumeAll();
    expect(sup.canStart()).toBe(false);
    await sup.stop(owner(1));
    expect(sup.canStart()).toBe(true);
  });

  it("first port is 9100", () => {
    expect(FIRST_AGENT_PORT).toBe(9100);
  });
});

describe("createGuardianSweeper", () => {
  const GUARD_MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  it("sends the guardian's QOR minus 0.3 QOR to the funder in a hybrid tx from the guardian, nothing at or below the reserve", async () => {
    const store = createStore(mkdtempSync(join(tmpdir(), "sw-")));
    store.writeSecrets(owner(1), { GAS_MNEMONIC: GUARD_MN, AGENT_ED25519_SK: "22".repeat(32) });
    const g = await deriveUnifiedAccount(GUARD_MN);
    const sent: { from: string; mode: string; value: any }[] = [];
    let balance = 950_000n;
    const sweep = createGuardianSweeper({
      store,
      funderCosmos: "qor1funder",
      chain: {
        uqorBalance: async (c) => (c === g.cosmos ? balance : 0n),
        broadcast: async (acc, msgs, _memo, mode) => (sent.push({ from: acc.cosmos, mode, value: msgs[0]!.value }), "SWEEP1"),
      },
    });
    expect(GUARDIAN_FEE_RESERVE_UQOR).toBe(300_000n);
    expect(await sweep(owner(1))).toBe("SWEEP1");
    expect(sent).toEqual([
      { from: g.cosmos, mode: "hybrid", value: { fromAddress: g.cosmos, toAddress: "qor1funder", amount: [{ denom: "uqor", amount: "650000" }] } },
    ]);
    balance = 300_000n;
    expect(await sweep(owner(1))).toBeNull();
    // 0.5 QOR above the reserve is dust: not worth a 0.225 QOR fee.
    balance = 800_000n;
    expect(await sweep(owner(1))).toBeNull();
    balance = 800_001n;
    expect(await sweep(owner(1))).toBe("SWEEP1");
    sent.pop();
    expect(sent.length).toBe(1);
  });
});

describe("maxAgentsFromEnv", () => {
  it("defaults to MAX_AGENTS and reads a positive whole number", () => {
    expect(maxAgentsFromEnv({})).toBe(MAX_AGENTS);
    expect(maxAgentsFromEnv({ HOSTED_MAX_AGENTS: "" })).toBe(MAX_AGENTS);
    expect(maxAgentsFromEnv({ HOSTED_MAX_AGENTS: "4" })).toBe(4);
  });
  it("fails at boot on anything else", () => {
    for (const v of ["0", "-1", "4.5", "abc", "4x"]) expect(() => maxAgentsFromEnv({ HOSTED_MAX_AGENTS: v })).toThrow(/HOSTED_MAX_AGENTS/);
  });
});
