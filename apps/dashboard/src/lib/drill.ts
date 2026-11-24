import { AGENT_URL } from "./agent";

/** Wire types of the agent's /drill API (apps/agent/src/drill.ts), copied: the dashboard does not import the agent. */
export const DRILL_STAGES = ["fresh owner", "setup", "agent", "attack", "incident", "recovery", "verdict"] as const;
export type DrillStage = (typeof DRILL_STAGES)[number];
export type DrillStatus = "idle" | "running" | "pass" | "fail";

export type DrillState = {
  status: DrillStatus;
  runId: string | null;
  stage: DrillStage | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  lines: string[];
};

/** One `verdict.json` (the cli's `VerdictFile`), as GET /drill/runs serves it. */
export type VerdictFile = {
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

export type StageStatus = "done" | "active" | "pending" | "failed";

const isStr = (x: unknown): x is string => typeof x === "string";
const isStrOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";
const isStage = (x: unknown): x is DrillStage => (DRILL_STAGES as readonly unknown[]).includes(x);

/** Validate a /drill body or an SSE frame. Throws on a bad shape. */
export function parseDrillState(x: unknown): DrillState {
  if (typeof x !== "object" || x === null) throw new Error("drill state: not an object");
  const o = x as Record<string, unknown>;
  if (o.status !== "idle" && o.status !== "running" && o.status !== "pass" && o.status !== "fail") throw new Error("drill state: bad status");
  if (!isStrOrNull(o.runId) || !isStrOrNull(o.startedAt) || !isStrOrNull(o.endedAt) || !isStrOrNull(o.error)) throw new Error("drill state: bad field");
  if (o.stage !== null && !isStage(o.stage)) throw new Error("drill state: bad stage");
  if (!Array.isArray(o.lines) || !o.lines.every(isStr)) throw new Error("drill state: bad lines");
  return { status: o.status, runId: o.runId, stage: o.stage as DrillStage | null, startedAt: o.startedAt, endedAt: o.endedAt, error: o.error, lines: [...o.lines] };
}

/** Validate GET /drill/runs; malformed rows are dropped. */
export function parseDrillRuns(x: unknown): VerdictFile[] {
  if (!Array.isArray(x)) return [];
  const out: VerdictFile[] = [];
  for (const r of x) {
    if (typeof r !== "object" || r === null) continue;
    const v = r as Record<string, unknown>;
    const ok =
      isStr(v.runId) && (v.mode === "drill" || v.mode === "demo") && typeof v.pass === "boolean" &&
      Array.isArray(v.failures) && v.failures.every(isStr) && isStrOrNull(v.firstDrainBlock) && isStrOrNull(v.blocks) &&
      isStr(v.keptPct) && isStrOrNull(v.incident) && isStr(v.owner) && isStr(v.vault) && isStr(v.checkedAt);
    if (ok) out.push({ ...(v as unknown as VerdictFile), failures: [...(v.failures as string[])] });
  }
  return out;
}

/** Mark of one stage: before the current one done, the current one active (failed when the drill failed there), after pending. */
export function stageStatus(s: DrillState, stage: DrillStage): StageStatus {
  if (s.status === "idle" || s.stage === null) return "pending";
  const cur = DRILL_STAGES.indexOf(s.stage);
  const i = DRILL_STAGES.indexOf(stage);
  if (s.status === "pass") return "done";
  if (i < cur) return "done";
  if (i > cur) return "pending";
  return s.status === "fail" ? "failed" : "active";
}

async function readError(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as unknown;
    if (typeof b === "object" && b !== null && typeof (b as { error?: unknown }).error === "string") return (b as { error: string }).error;
  } catch {
    // a non-JSON body: the status says enough
  }
  return `HTTP ${r.status}`;
}

/** POST /drill. The agent's refusal (409 running, 503 no drill guardian, 403/415) is thrown verbatim. */
export async function startDrill(timeoutMs = 10_000): Promise<DrillState> {
  const r = await fetch(`${AGENT_URL}/drill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(await readError(r));
  return parseDrillState(await r.json());
}

async function get(path: string): Promise<unknown> {
  const r = await fetch(`${AGENT_URL}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`agent ${path}: HTTP ${r.status}`);
  return r.json();
}
export const fetchDrill = async (): Promise<DrillState> => parseDrillState(await get("/drill"));
export const fetchDrillRuns = async (): Promise<VerdictFile[]> => parseDrillRuns(await get("/drill/runs"));

/** SSE `drill` frames (the full state on connect and on every change). Returns the unsubscribe. */
export function subscribeDrill(onState: (s: DrillState) => void): () => void {
  const es = new EventSource(`${AGENT_URL}/drill/events`);
  es.addEventListener("drill", (ev) => {
    try {
      onState(parseDrillState(JSON.parse((ev as MessageEvent<string>).data)));
    } catch {
      // a malformed frame is dropped; the next frame carries the full state
    }
  });
  return () => es.close();
}
