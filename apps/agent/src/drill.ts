import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * Fire drill (Task 6G): the agent runs `demo.sh --drill` (a throwaway owner, the drill's own guardian, agent on :8788
 * and incidents file) and turns its output into a state the dashboard follows. It never reads a run.env (it holds the
 * fresh owner's mnemonic): only verdict.json, and it only appends to its own drill.log in a run dir.
 */

export const DRILL_STAGES = ["fresh owner", "setup", "agent", "attack", "incident", "recovery", "verdict"] as const;
export type DrillStage = (typeof DRILL_STAGES)[number];

export type DrillState = {
  status: "idle" | "running" | "pass" | "fail";
  runId: string | null;
  stage: DrillStage | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  /** The last MAX_LINES output lines, redacted. */
  lines: string[];
};

/** `<run dir>/verdict.json`, as `demo-check --out` writes it (apps/cli/src/democheck.ts `VerdictFile`). */
export type DrillRunSummary = {
  runId: string;
  mode: "drill" | "demo";
  pass: boolean;
  failures: string[];
  firstDrainBlock: string | null;
  blocks: string | null;
  keptPct: string;
  incident: string | null;
  owner: string;
  vault: string;
  checkedAt: string;
};

export type DrillRunner = {
  /** Throws DrillError: 409 while a drill runs, 503 without the drill guardian file. */
  start(): DrillState;
  state(): DrillState;
  subscribe(fn: (s: DrillState) => void): () => void;
  /** The newest MAX_RUNS verdicts, newest first. */
  runs(): DrillRunSummary[];
  /** Kill the running drill's process group (agent shutdown). */
  stop(): void;
};

export class DrillError extends Error {
  constructor(readonly status: 409 | 503, message: string) {
    super(message);
    this.name = "DrillError";
  }
}

export const DRILL_TIMEOUT_MS = 15 * 60_000;
/** After the SIGTERM, how long the group gets before one SIGKILL (a stuck `running` would 409 every later drill). */
export const DRILL_KILL_GRACE_MS = 15_000;
const MAX_LINES = 200;
const MAX_RUNS = 20;
const RUN_ID = "[0-9A-Za-z_-]+";
const DRILL_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "SHELL"] as const;

/** One `demo.sh` output line: a stage header, the fresh owner's run id, or the run's own PASS/FAIL line. */
export function parseDrillLine(line: string): { stage?: DrillStage; runId?: string; result?: "pass" | "fail" } | null {
  const step = /^--- (.+)$/.exec(line);
  if (step) {
    if (/^verdict \(run /.test(step[1])) return { stage: "verdict" };
    const stage = DRILL_STAGES.find((s) => s === step[1]);
    return stage ? { stage } : null;
  }
  const run = new RegExp(`^run (${RUN_ID}): fresh owner `).exec(line);
  if (run) return { runId: run[1] };
  // Anchored, so the parent wrapper's `PASS: 1/1 runs` and `FAIL: run 1/1 failed; stopping` never match.
  const result = new RegExp(`^(PASS|FAIL): run (?:${RUN_ID}|\\?)(?: stopped \\(exit \\d+\\))?$`).exec(line);
  if (result) return { result: result[1] === "PASS" ? "pass" : "fail" };
  return null;
}

/**
 * Review Focus 3: nothing that looks like a secret leaves the agent. A line that assigns a mnemonic or a secret key
 * (`…MNEMONIC=`, `…_SK=`) is dropped whole; a run of 12+ lowercase words (any whitespace between them, or a JSON array
 * of quoted words) is replaced.
 */
export function redactLine(line: string): string {
  if (/MNEMONIC=|_SK=/i.test(line)) return "[redacted]";
  return line
    .replace(/\[\s*"[a-z]+"(?:\s*,\s*"[a-z]+"){11,}\s*\]/g, "[redacted]")
    .replace(/(?<![A-Za-z0-9])[a-z]+(?:\s+[a-z]+){11,}(?![A-Za-z0-9])/g, "[redacted]");
}

/**
 * Review Focus 2: the child gets a bare environment. demo.sh reads the root .env itself; the main agent's own
 * settings (AGENT_PORT, INCIDENTS_FILE, GAS_MNEMONIC…) must never reach the drill.
 */
export function drillEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DRILL_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k] as string;
  return out;
}

/** The part of node's ChildProcess the runner uses. */
export type DrillChild = {
  pid?: number;
  stdout: { on(ev: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(ev: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
  on(ev: "close", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(ev: "error", fn: (e: Error) => void): unknown;
};

export type DrillDeps = {
  spawn: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; detached: true; stdio: ["ignore", "pipe", "pipe"] },
  ) => DrillChild;
  /** process.kill: called with the NEGATIVE pid, i.e. the whole process group. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  repoRoot: string;
  runsDir: string;
  guardianFile: string;
  /** The agent's environment, filtered by drillEnv. Default process.env. */
  env?: Record<string, string | undefined>;
  exists(p: string): boolean;
  readFile(p: string): string;
  /** Directory names in `p`; [] when it does not exist. */
  listDirs(p: string): string[];
  /** Append to a file, creating it 0600; never creates a directory. */
  appendFile(p: string, data: string): void;
  now(): Date;
  timeoutMs?: number;
  /** For the 503 message: the guardian file is shown home-relative (`~/…`). Default os.homedir(). */
  home?: string;
  /** setTimeout; returns its cancel. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log: (line: string) => void;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IDLE: DrillState = { status: "idle", runId: null, stage: null, startedAt: null, endedAt: null, error: null, lines: [] };

export function createDrillRunner(deps: DrillDeps): DrillRunner {
  const timeoutMs = deps.timeoutMs ?? DRILL_TIMEOUT_MS;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return () => clearTimeout(t);
    });
  const log = deps.log;
  let state: DrillState = IDLE;
  const subscribers = new Set<(s: DrillState) => void>();
  // The running drill (null when idle or finished).
  let run: {
    pid?: number;
    cancelTimer: () => void;
    cancelKill: () => void;
    killReason: string | null;
    spawnError: string | null;
    passLine: boolean;
    lastFail: string | null;
    pendingLog: string[];
    logBroken: boolean;
    finished: boolean;
  } | null = null;

  const snapshot = (): DrillState => ({ ...state, lines: [...state.lines] });
  const update = (next: Partial<DrillState>) => {
    state = { ...state, ...next };
    for (const fn of subscribers) {
      try {
        fn(snapshot());
      } catch (e) {
        log(`drill subscriber error: ${errorText(e)}`);
      }
    }
  };

  /** drill.log goes in the run dir once fresh-owner has created it; until then lines wait in memory. */
  function flushLog() {
    if (!run || run.logBroken || !state.runId || run.pendingLog.length === 0) return;
    const dir = join(deps.runsDir, state.runId);
    if (!deps.exists(dir)) return;
    try {
      deps.appendFile(join(dir, "drill.log"), run.pendingLog.map((l) => `${l}\n`).join(""));
      run.pendingLog = [];
    } catch (e) {
      run.logBroken = true;
      log(`drill.log write failed: ${errorText(e)}`);
    }
  }

  function onLine(raw: string) {
    if (!run) return;
    const line = redactLine(raw.replace(/\r$/, ""));
    if (line.trim() === "") return;
    run.pendingLog.push(line);
    const parsed = parseDrillLine(line);
    if (parsed?.result === "pass") run.passLine = true;
    if (parsed?.result === "fail" || (line.startsWith("FAIL:") && !run.lastFail)) run.lastFail = line;
    const lines = [...state.lines, line].slice(-MAX_LINES);
    update({ lines, ...(parsed?.stage ? { stage: parsed.stage } : {}), ...(parsed?.runId && !state.runId ? { runId: parsed.runId } : {}) });
    flushLog();
  }

  function lineSplitter() {
    const decoder = new StringDecoder("utf8");
    let rest = "";
    return {
      data(chunk: Buffer | string) {
        rest += typeof chunk === "string" ? chunk : decoder.write(chunk);
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        parts.forEach(onLine);
      },
      end() {
        rest += decoder.end();
        if (rest) onLine(rest);
        rest = "";
      },
    };
  }

  /**
   * One SIGTERM per run: a second one would cut demo.sh's exit trap (which stops the drill agent) short. If the group
   * has not closed DRILL_KILL_GRACE_MS later, one SIGKILL (demo.sh's trap cannot run then).
   */
  function killGroup(reason: string) {
    const current = run;
    if (!current || current.finished || current.pid === undefined || current.killReason) return;
    current.killReason = reason;
    const pid = current.pid;
    const send = (signal: NodeJS.Signals) => {
      try {
        deps.kill(-pid, signal);
      } catch (e) {
        log(`drill kill (${signal}) failed: ${errorText(e)}`);
      }
    };
    send("SIGTERM");
    current.cancelKill = setTimer(() => {
      if (current.finished) return;
      log(`fire drill still running ${DRILL_KILL_GRACE_MS / 1000} s after SIGTERM: SIGKILL`);
      send("SIGKILL");
    }, DRILL_KILL_GRACE_MS);
  }

  return {
    start() {
      if (state.status === "running") throw new DrillError(409, "a fire drill is already running");
      if (!deps.exists(deps.guardianFile)) {
        const home = resolve(deps.home ?? homedir());
        const shown = deps.guardianFile.startsWith(`${home}/`) ? `~/${deps.guardianFile.slice(home.length + 1)}` : deps.guardianFile;
        throw new DrillError(503, `no drill guardian file ${shown} (create and fund it: pnpm cli drill-guardian init)`);
      }
      const out = lineSplitter();
      const err = lineSplitter();
      const current: NonNullable<typeof run> = {
        cancelTimer: () => {},
        cancelKill: () => {},
        killReason: null,
        spawnError: null,
        passLine: false,
        lastFail: null,
        pendingLog: [],
        logBroken: false,
        finished: false,
      };
      run = current;
      state = { ...IDLE };
      update({ status: "running", startedAt: deps.now().toISOString() });

      const finish = (code: number | null, signal: NodeJS.Signals | null = null) => {
        if (current.finished) return;
        out.end();
        err.end();
        current.cancelTimer();
        current.cancelKill();
        flushLog();
        if (current.pendingLog.length && !current.logBroken) log("drill.log not written: the run dir was never created");
        current.finished = true;
        const pass = code === 0 && current.passLine && !current.killReason && !current.spawnError;
        const error = pass ? null : current.killReason ?? current.spawnError ?? current.lastFail ?? (code === null && signal ? `exit signal ${signal}` : `exit ${code}`);
        update({ status: pass ? "pass" : "fail", error, endedAt: deps.now().toISOString() });
        run = null;
      };

      let child: DrillChild;
      try {
        child = deps.spawn("bash", [join(deps.repoRoot, "demo.sh"), "--drill"], {
          cwd: deps.repoRoot,
          env: drillEnv(deps.env ?? process.env),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        current.spawnError = errorText(e);
        finish(null);
        return snapshot();
      }
      current.pid = child.pid;
      child.stdout?.on("data", out.data);
      child.stderr?.on("data", err.data);
      child.on("error", (e) => {
        current.spawnError ??= errorText(e);
        if (child.pid === undefined) finish(null); // never started: no close may follow
      });
      child.on("close", (code, signal) => finish(code, signal));
      current.cancelTimer = setTimer(() => {
        log(`fire drill timed out after ${timeoutMs / 60_000} min: killing it`);
        killGroup(`timed out after ${timeoutMs / 60_000} min`);
      }, timeoutMs);
      return snapshot();
    },

    state: snapshot,

    subscribe(fn) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },

    runs() {
      const ids = deps.listDirs(deps.runsDir).filter((d) => new RegExp(`^${RUN_ID}$`).test(d)).sort().reverse();
      const out: DrillRunSummary[] = [];
      for (const id of ids) {
        if (out.length >= MAX_RUNS) break;
        const file = join(deps.runsDir, id, "verdict.json");
        if (!deps.exists(file)) continue; // demo-check threw, or the run stopped before its verdict
        let parsed: unknown;
        try {
          parsed = JSON.parse(deps.readFile(file));
        } catch {
          log(`skipping ${file}: unreadable or not JSON verdict`); // never the content (V8 quotes it)
          continue;
        }
        const v = toSummary(parsed);
        if (v) out.push(v);
        else log(`skipping ${file}: malformed verdict`);
      }
      return out;
    },

    stop() {
      killGroup("stopped: the agent is shutting down");
    },
  };
}

const isStr = (x: unknown): x is string => typeof x === "string";
const isStrOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";

/** Validate a parsed verdict.json and copy its fields by name, so nothing else in the file is ever served. */
function toSummary(x: unknown): DrillRunSummary | null {
  if (typeof x !== "object" || x === null) return null;
  const v = x as Record<string, unknown>;
  const ok =
    isStr(v.runId) && (v.mode === "drill" || v.mode === "demo") && typeof v.pass === "boolean" &&
    Array.isArray(v.failures) && v.failures.every(isStr) && isStrOrNull(v.firstDrainBlock) && isStrOrNull(v.blocks) &&
    isStr(v.keptPct) && isStrOrNull(v.incident) && isStr(v.owner) && isStr(v.vault) && isStr(v.checkedAt);
  if (!ok) return null;
  return {
    runId: v.runId as string,
    mode: v.mode as "drill" | "demo",
    pass: v.pass as boolean,
    failures: [...(v.failures as string[])],
    firstDrainBlock: v.firstDrainBlock as string | null,
    blocks: v.blocks as string | null,
    keptPct: v.keptPct as string,
    incident: v.incident as string | null,
    owner: v.owner as string,
    vault: v.vault as string,
    checkedAt: v.checkedAt as string,
  };
}
