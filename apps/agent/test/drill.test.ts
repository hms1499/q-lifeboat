import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createDrillRunner,
  DRILL_KILL_GRACE_MS,
  DRILL_STAGES,
  DRILL_TIMEOUT_MS,
  DrillError,
  drillEnv,
  parseDrillLine,
  redactLine,
  type DrillState,
} from "../src/drill";

const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const RUN = "20261124T093012Z";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94";

describe("parseDrillLine", () => {
  it("test_parseStageLines", () => {
    expect(DRILL_STAGES).toEqual(["fresh owner", "setup", "agent", "attack", "incident", "recovery", "verdict"]);
    for (const stage of DRILL_STAGES.filter((s) => s !== "verdict")) expect(parseDrillLine(`--- ${stage}`)).toEqual({ stage });
    expect(parseDrillLine(`--- verdict (run ${RUN}, agent log /Users/x/.config/qday/runs/${RUN}/agent.log)`)).toEqual({ stage: "verdict" });
    // Not a stage: the failure tail, an unknown step, ordinary output.
    expect(parseDrillLine("--- agent log (last 20 lines)")).toBeNull();
    expect(parseDrillLine("--- deploy")).toBeNull();
    expect(parseDrillLine("setup done")).toBeNull();
    expect(parseDrillLine("")).toBeNull();
  });

  it("test_parseRunIdAndResult", () => {
    expect(parseDrillLine(`run ${RUN}: fresh owner ${ADDR} (qor1abc), attacker 0x1, safe 0x2`)).toEqual({ runId: RUN });
    expect(parseDrillLine(`PASS: run ${RUN}`)).toEqual({ result: "pass" });
    expect(parseDrillLine(`FAIL: run ${RUN}`)).toEqual({ result: "fail" });
    expect(parseDrillLine(`FAIL: run ${RUN} stopped (exit 1)`)).toEqual({ result: "fail" });
    expect(parseDrillLine("FAIL: run ? stopped (exit 1)")).toEqual({ result: "fail" });
    // The parent wrapper's lines are not a run id nor a run result.
    expect(parseDrillLine("PASS: 1/1 runs")).toBeNull();
    expect(parseDrillLine("FAIL: run 1/1 failed; stopping")).toBeNull();
    expect(parseDrillLine("=== demo run 1/1 ===")).toBeNull();
    // A run id with path characters is never taken.
    expect(parseDrillLine("run ../../etc: fresh owner 0x1 (q), attacker 0x2, safe 0x3")).toBeNull();
  });
});

describe("redactLine", () => {
  it("test_redactsMnemonicLikeLine", () => {
    expect(redactLine(MNEMONIC)).toBe("[redacted]");
    expect(redactLine(`seed "${MNEMONIC} zoo zone" printed`)).toBe('seed "[redacted]" printed');
    const addrLine = `run ${RUN}: fresh owner ${ADDR} (qor14zxae5abc), attacker 0x1, safe 0x2`;
    expect(redactLine(addrLine)).toBe(addrLine);
    const tx = "rescue tx 0xb4119a4c00000000000000000000000000000000000000000000000000000000 in block 123";
    expect(redactLine(tx)).toBe(tx);
    const eleven = MNEMONIC.split(" ").slice(0, 11).join(" ");
    expect(redactLine(eleven)).toBe(eleven);
  });

  it("redacts a line that assigns a mnemonic or a secret key, whatever its value looks like", () => {
    expect(redactLine("OWNER_MNEMONIC=abandon ability")).toBe("[redacted]");
    expect(redactLine("export drill_gas_mnemonic='x y z'")).toBe("[redacted]");
    expect(redactLine("AGENT_ED25519_SK=0x" + "ab".repeat(32))).toBe("[redacted]");
    expect(redactLine("agent_ed25519_sk=deadbeef")).toBe("[redacted]");
    expect(redactLine("DRILL_GUARDIAN_ADDRESS=" + ADDR)).toBe("DRILL_GUARDIAN_ADDRESS=" + ADDR);
  });

  it("redacts 12+ words split by any whitespace, and a JSON array of 12+ quoted words", () => {
    const words = MNEMONIC.split(" ");
    expect(redactLine(words.join("  "))).toBe("[redacted]");
    expect(redactLine(`seed: ${words.join(" \t")}.`)).toBe("seed: [redacted].");
    expect(redactLine(`words ${JSON.stringify(words)} end`)).toBe("words [redacted] end");
    expect(redactLine(`{"w":${JSON.stringify(words, null, 1).replace(/\n/g, " ")}}`)).toBe('{"w":[redacted]}');
    const eleven = JSON.stringify(words.slice(0, 11));
    expect(redactLine(eleven)).toBe(eleven);
  });
});

describe("drillEnv", () => {
  it("test_drillEnvDropsAgentVars", () => {
    const env = drillEnv({
      PATH: "/usr/bin", HOME: "/Users/o", TMPDIR: "/tmp/x", LANG: "en_US.UTF-8", USER: "o", SHELL: "/bin/zsh",
      AGENT_PORT: "8787", INCIDENTS_FILE: "/repo/data/incidents.jsonl", GAS_MNEMONIC: MNEMONIC, OWNER_MNEMONIC: MNEMONIC,
      RUN_ID: "x", DRILL_AGENT_PORT: "9999", NODE_OPTIONS: "--require x", EMPTY: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/o", TMPDIR: "/tmp/x", LANG: "en_US.UTF-8", USER: "o", SHELL: "/bin/zsh" });
    expect(drillEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});

// ---------------------------------------------------------------- the runner, with a fake child process

type FakeChild = EventEmitter & { pid: number | undefined; stdout: EventEmitter; stderr: EventEmitter };
const fakeChild = (pid = 4242): FakeChild => Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter() });

function setup(over: { guardian?: boolean; dirs?: string[]; files?: Record<string, string>; runDirExists?: boolean } = {}) {
  const child = fakeChild();
  const spawn = vi.fn((): FakeChild => child);
  const kill = vi.fn();
  const appended: [string, string][] = [];
  const logs: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const files = over.files ?? {};
  let runDirExists = over.runDirExists ?? true;
  const readFile = vi.fn((p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  });
  const runner = createDrillRunner({
    spawn,
    kill,
    repoRoot: "/repo",
    runsDir: "/home/o/.config/qday/runs",
    guardianFile: "/home/o/.config/qday/drill-guardian.env",
    home: "/home/o",
    env: { PATH: "/bin", HOME: "/home/o", GAS_MNEMONIC: MNEMONIC, AGENT_PORT: "8787", INCIDENTS_FILE: "/repo/data/i.jsonl" },
    exists: (p) =>
      p === "/home/o/.config/qday/drill-guardian.env" ? over.guardian !== false
      : p === `/home/o/.config/qday/runs/${RUN}` ? runDirExists
      : p in files,
    readFile,
    listDirs: () => over.dirs ?? [],
    appendFile: (p, data) => void appended.push([p, data]),
    now: () => new Date("2026-11-24T09:30:00.000Z"),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return () => void (t.cleared = true);
    },
    log: (l) => void logs.push(l),
  });
  const out = (text: string) => child.stdout.emit("data", Buffer.from(text));
  const err = (text: string) => child.stderr.emit("data", Buffer.from(text));
  const exit = (code: number | null, signal: NodeJS.Signals | null = null) => child.emit("close", code, signal);
  return { runner, child, spawn, kill, appended, logs, timers, readFile, out, err, exit, setRunDir: (v: boolean) => void (runDirExists = v) };
}

describe("createDrillRunner: start", () => {
  it("spawns `bash <repo>/demo.sh --drill` detached, in the repo, with the drill env only", () => {
    const { runner, spawn } = setup();
    expect(runner.state()).toEqual({ status: "idle", runId: null, stage: null, startedAt: null, endedAt: null, error: null, lines: [] });
    const s = runner.start();
    expect(s).toMatchObject({ status: "running", startedAt: "2026-11-24T09:30:00.000Z", runId: null, stage: null, error: null });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("bash", ["/repo/demo.sh", "--drill"], {
      cwd: "/repo",
      env: { PATH: "/bin", HOME: "/home/o" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("test_secondStartWhileRunningIs409", () => {
    const { runner, spawn, out, exit } = setup();
    runner.start();
    let e: unknown;
    try { runner.start(); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(DrillError);
    expect((e as DrillError).status).toBe(409);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Once finished, a new drill may start.
    out(`PASS: run ${RUN}\n`);
    exit(0);
    expect(runner.start().status).toBe("running");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("test_startWithoutGuardianFileIs503AndSpawnsNothing", () => {
    const { runner, spawn } = setup({ guardian: false });
    let e: unknown;
    try { runner.start(); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(DrillError);
    expect((e as DrillError).status).toBe(503);
    expect((e as DrillError).message).toContain("pnpm cli drill-guardian init");
    expect((e as DrillError).message).toContain("~/.config/qday/drill-guardian.env");
    expect((e as DrillError).message).not.toContain("/home/o"); // home-relative: no user name in the browser
    expect(spawn).not.toHaveBeenCalled();
    expect(runner.state().status).toBe("idle");
  });
});

describe("createDrillRunner: a run", () => {
  it("test_passOnExit0WithPassLine", () => {
    const { runner, out, exit, appended, timers } = setup();
    runner.start();
    out("=== demo run 1/1 ===\nfire drill: guardian 0xabc, agent on :8788\n\n--- fresh o");
    out(`wner\nrun ${RUN}: fresh owner ${ADDR} (qor1x), attacker 0x1, safe 0x2\n`);
    expect(runner.state()).toMatchObject({ runId: RUN, stage: "fresh owner", status: "running" });
    out("--- setup\n--- agent\n--- attack\n--- incident\n--- recovery\n");
    expect(runner.state().stage).toBe("recovery");
    out(`--- verdict (run ${RUN}, agent log /x/agent.log)\nPASS: run ${RUN}\nPASS: 1/1 runs\n`);
    expect(runner.state().stage).toBe("verdict");
    expect(runner.state().status).toBe("running"); // pass is decided on exit
    exit(0);
    const s = runner.state();
    expect(s).toMatchObject({ status: "pass", error: null, endedAt: "2026-11-24T09:30:00.000Z" });
    expect(s.lines).toContain(`PASS: run ${RUN}`);
    expect(s.lines).not.toContain(""); // blank lines are dropped
    // drill.log: every line, including those before the run id was known, in order, in the run dir only.
    const log = `/home/o/.config/qday/runs/${RUN}/drill.log`;
    expect(new Set(appended.map(([p]) => p))).toEqual(new Set([log]));
    const text = appended.map(([, d]) => d).join("");
    expect(text.startsWith("=== demo run 1/1 ===\nfire drill: guardian 0xabc, agent on :8788\n--- fresh owner\n")).toBe(true);
    expect(text.endsWith(`PASS: run ${RUN}\nPASS: 1/1 runs\n`)).toBe(true);
    expect(timers[0].cleared).toBe(true);
  });

  it("exit 0 without a PASS line is a fail", () => {
    const { runner, out, exit } = setup();
    runner.start();
    out("--- setup\n");
    exit(0);
    expect(runner.state()).toMatchObject({ status: "fail", error: "exit 0" });
  });

  it("test_failOnNonZeroExit", () => {
    const { runner, out, err, exit } = setup();
    runner.start();
    out(`run ${RUN}: fresh owner ${ADDR} (q), attacker 0x1, safe 0x2\n--- attack\n`);
    err("attack (b) refused\n");
    out(`FAIL: run ${RUN} stopped (exit 1)\nFAIL: run 1/1 failed; stopping\n`);
    exit(1);
    expect(runner.state()).toMatchObject({ status: "fail", error: `FAIL: run ${RUN} stopped (exit 1)`, stage: "attack" });
    expect(runner.state().lines).toContain("attack (b) refused"); // stderr is forwarded too

    // A refusal before any run (exit 2, stderr only): no FAIL line, so the exit code.
    const r2 = setup();
    r2.runner.start();
    r2.err("refusing --drill: DRILL_AGENT_PORT 8787 is the main agent's port\n");
    r2.exit(2);
    expect(r2.runner.state()).toMatchObject({ status: "fail", error: "exit 2", runId: null });
    expect(r2.appended).toEqual([]); // no run dir known: nothing written
  });

  it("a spawn error fails the drill instead of throwing", () => {
    const { runner, child } = setup();
    runner.start();
    child.emit("error", new Error("spawn bash ENOENT"));
    child.emit("close", -2, null);
    expect(runner.state()).toMatchObject({ status: "fail", error: "spawn bash ENOENT" });
  });

  it("a spawn error with no pid (no close follows) fails the drill, and a later start works", () => {
    const { runner, spawn, timers } = setup();
    const dead = Object.assign(fakeChild(), { pid: undefined }); // spawn failed: node leaves pid undefined
    spawn.mockReturnValueOnce(dead);
    runner.start();
    dead.emit("error", new Error("spawn bash ENOENT"));
    expect(runner.state()).toMatchObject({ status: "fail", error: "spawn bash ENOENT" });
    expect(timers[0].cleared).toBe(true);
    expect(runner.start().status).toBe("running");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("a signal exit with no kill reason reports the signal", () => {
    const { runner, exit } = setup();
    runner.start();
    exit(null, "SIGKILL");
    expect(runner.state()).toMatchObject({ status: "fail", error: "exit signal SIGKILL" });
  });

  it("redacts mnemonic-like output in state and drill.log", () => {
    const { runner, out, exit, appended } = setup();
    runner.start();
    out(`run ${RUN}: fresh owner ${ADDR} (q), attacker 0x1, safe 0x2\n${MNEMONIC}\n`);
    exit(1);
    expect(runner.state().lines.join("\n")).not.toContain("abandon");
    expect(runner.state().lines).toContain("[redacted]");
    expect(appended.map(([, d]) => d).join("")).not.toContain("abandon");
  });

  it("keeps buffering drill.log until the run dir exists (never creates it)", () => {
    const { runner, out, exit, appended, setRunDir } = setup({ runDirExists: false });
    runner.start();
    out(`run ${RUN}: fresh owner ${ADDR} (q), attacker 0x1, safe 0x2\nfunding\n`);
    expect(appended).toEqual([]);
    setRunDir(true);
    out("--- setup\n");
    expect(appended.map(([, d]) => d).join("")).toBe(`run ${RUN}: fresh owner ${ADDR} (q), attacker 0x1, safe 0x2\nfunding\n--- setup\n`);
    exit(0);
  });
});

describe("createDrillRunner: stop and timeout", () => {
  it("test_timeoutKillsProcessGroup", () => {
    const { runner, kill, timers, exit } = setup();
    runner.start();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(DRILL_TIMEOUT_MS);
    expect(DRILL_TIMEOUT_MS).toBe(15 * 60_000);
    timers[0].fn();
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    exit(null, "SIGTERM");
    expect(runner.state()).toMatchObject({ status: "fail", error: expect.stringMatching(/timed out after 15 min/) });
  });

  it("test_stopKillsProcessGroup", () => {
    const { runner, kill, exit } = setup();
    runner.stop(); // idle: nothing to kill
    expect(kill).not.toHaveBeenCalled();
    runner.start();
    runner.stop();
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    runner.stop(); // SIGINT then the exit hook: still one SIGTERM, so demo.sh's cleanup trap runs to the end
    expect(kill).toHaveBeenCalledTimes(1);
    exit(130);
    expect(runner.state()).toMatchObject({ status: "fail", error: expect.stringMatching(/stopped/) });
    runner.stop(); // finished: no second kill
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("escalates to one SIGKILL when the group has not closed 15 s after the SIGTERM", () => {
    const { runner, kill, timers, exit } = setup();
    runner.start();
    runner.stop();
    expect(DRILL_KILL_GRACE_MS).toBe(15_000);
    expect(timers).toHaveLength(2);
    expect(timers[1].ms).toBe(DRILL_KILL_GRACE_MS);
    expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"]]);
    timers[1].fn();
    expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
    runner.stop(); // still once
    expect(kill).toHaveBeenCalledTimes(2);
    exit(null, "SIGKILL");
    expect(runner.state()).toMatchObject({ status: "fail", error: expect.stringMatching(/stopped/) });
    expect(runner.start().status).toBe("running"); // not stuck at 409
  });

  it("no SIGKILL when the group closes within the grace period", () => {
    const { runner, kill, timers, exit } = setup();
    runner.start();
    timers[0].fn(); // the timeout's SIGTERM
    exit(130);
    expect(timers[1].cleared).toBe(true);
    timers[1].fn(); // even if it fired late
    expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"]]);
  });

  it("a kill that throws (the group is already gone) is logged, not thrown", () => {
    const { runner, kill, logs } = setup();
    kill.mockImplementation(() => { throw new Error("kill ESRCH"); });
    runner.start();
    expect(() => runner.stop()).not.toThrow();
    expect(logs.some((l) => l.includes("ESRCH"))).toBe(true);
  });
});

describe("createDrillRunner: subscribers and lines", () => {
  it("test_subscribersGetEveryChange", () => {
    const { runner, out, exit } = setup();
    const seen: DrillState[] = [];
    const off = runner.subscribe((s) => void seen.push(s));
    runner.start();
    out(`run ${RUN}: fresh owner ${ADDR} (q), attacker 0x1, safe 0x2\n--- setup\n`);
    exit(1);
    expect(seen.map((s) => s.status)).toEqual(["running", "running", "running", "fail"]);
    expect(seen[1].runId).toBe(RUN);
    expect(seen[2].stage).toBe("setup");
    seen[3].lines.push("mutated"); // a subscriber's copy is its own
    expect(runner.state().lines).not.toContain("mutated");
    off();
    runner.start();
    expect(seen).toHaveLength(4);
  });

  it("a throwing subscriber does not break the others", () => {
    const { runner, logs } = setup();
    const ok = vi.fn();
    runner.subscribe(() => { throw new Error("boom"); });
    runner.subscribe(ok);
    runner.start();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });

  it("test_linesCappedAt200", () => {
    const { runner, out } = setup();
    runner.start();
    out(Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const { lines } = runner.state();
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("line 50");
    expect(lines[199]).toBe("line 249");
  });

  it("a new start clears the previous run's state", () => {
    const { runner, out, exit } = setup();
    runner.start();
    out(`run ${RUN}: fresh owner ${ADDR} (q), attacker 0x1, safe 0x2\n--- attack\n`);
    exit(1);
    expect(runner.start()).toMatchObject({ status: "running", runId: null, stage: null, error: null, endedAt: null, lines: [] });
  });
});

// ---------------------------------------------------------------- runs(): verdict.json only

const RUNS = "/home/o/.config/qday/runs";
const verdict = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, mode: "drill", pass: true, failures: [], firstDrainBlock: "100", blocks: "1", keptPct: "95.0",
  incident: "inc-1", owner: ADDR, vault: ADDR, checkedAt: "2026-11-24T09:40:00.000Z", ...over,
});

describe("createDrillRunner: runs", () => {
  it("test_runsReadsVerdictOnly", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `20261124T0${String(i).padStart(2, "0")}000Z`);
    const files: Record<string, string> = {};
    for (const id of ids) files[`${RUNS}/${id}/verdict.json`] = JSON.stringify(verdict(id));
    files[`${RUNS}/${ids[24]}/verdict.json`] = "{not json";
    files[`${RUNS}/${ids[23]}/verdict.json`] = JSON.stringify(verdict(ids[23], { pass: "yes" }));
    files[`${RUNS}/${ids[22]}/verdict.json`] = JSON.stringify({ ...verdict(ids[22], { pass: false, failures: ["slow"] }), OWNER_MNEMONIC: MNEMONIC });
    const { runner, readFile, logs } = setup({ dirs: [...ids, "20261124T999999Z", "not a run!"], files });
    const runs = runner.runs();
    // Never anything but verdict.json (run.env holds the fresh owner's mnemonic).
    for (const [p] of readFile.mock.calls) expect(p).toMatch(/\/verdict\.json$/);
    expect(readFile.mock.calls.some(([p]) => p.includes("run.env"))).toBe(false);
    // Newest first, at most 20, the two malformed ones skipped and logged, the dir without a verdict skipped.
    expect(runs).toHaveLength(20);
    expect(runs[0]).toEqual(verdict(ids[22], { pass: false, failures: ["slow"] })); // unknown fields dropped
    expect(runs.map((r) => r.runId)).toEqual(ids.slice(3, 23).reverse());
    expect(logs.filter((l) => l.includes("verdict"))).toHaveLength(2);
    expect(logs.join("\n")).not.toContain("not json");
  });

  it("no runs dir yet: no runs", () => {
    const { runner } = setup({ dirs: [] });
    expect(runner.runs()).toEqual([]);
  });
});
