import { useCallback, useEffect, useRef, useState } from "react";
import { Command, CopyText } from "../components/ui";
import { DRILL_STAGES, fetchDrill, fetchDrillRuns, stageStatus, startDrill, subscribeDrill, type DrillState, type VerdictFile } from "../lib/drill";
import { errorText } from "../lib/format";
import { useApp } from "../state";

/** The drill guardian setup command; run from the repo root (the CLI reads the root .env). */
const GUARDIAN_INIT_CMD = "pnpm cli drill-guardian init";

const STAGE_WORD = { done: "done", failed: "failed", active: "running", pending: "not started" } as const;
const STAGE_MARK = { done: "✓", failed: "✗", active: "", pending: "" } as const;
const pct = (k: string) => `${k}%`;
const when = (iso: string) => (Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleString());

export function Drill() {
  const { config } = useApp();
  const online = config.agentOnline;
  const [state, setState] = useState<DrillState | null>(null);
  const [runs, setRuns] = useState<VerdictFile[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [needsGuardian, setNeedsGuardian] = useState(false);
  const prevStatus = useRef<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await fetchDrillRuns());
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    let live = true;
    fetchDrill()
      .then((s) => live && setState(s))
      .catch((e) => live && setErr(errorText(e)));
    void loadRuns();
    const off = subscribeDrill((s) => live && setState(s));
    return () => {
      live = false;
      off();
    };
  }, [online, loadRuns]);

  // A drill that ends writes its verdict.json: re-read the runs.
  useEffect(() => {
    const st = state?.status ?? null;
    if ((st === "pass" || st === "fail") && prevStatus.current !== st) void loadRuns();
    prevStatus.current = st;
  }, [state?.status, loadRuns]);

  async function run() {
    setErr(null);
    setNeedsGuardian(false);
    setStarting(true);
    try {
      setState(await startDrill());
    } catch (e) {
      const m = errorText(e);
      setErr(m);
      setNeedsGuardian(m.includes("drill-guardian"));
    } finally {
      setStarting(false);
    }
  }

  const running = state?.status === "running";
  const ended = state?.status === "pass" || state?.status === "fail";
  const verdict = ended && state.runId ? runs.find((r) => r.runId === state.runId) : undefined;

  return (
    <>
      <h1>Fire drill</h1>
      <p className="lead">
        Proves the Guardian works without touching your account. A throwaway owner is created, protected, attacked and rescued on diana; the watched
        owner is not touched. One drill costs about 2 QOR of testnet funds, paid from the funder account (FUNDER_MNEMONIC in the root .env), never
        from the watched owner.
      </p>
      {!online ? (
        <div className="banner warn" role="status">
          <strong>Agent offline: drills are off.</strong> Start it from the repo root with <span className="mono">pnpm agent</span>.
        </div>
      ) : null}
      <div className="stack">
        <section className="card roomy">
          <div className="between">
            <h2>Drill</h2>
            <button type="button" className="btn primary" disabled={!online || running || starting} onClick={() => void run()}>
              {running ? "Running…" : "Run drill"}
            </button>
          </div>
          {err ? (
            <div className="banner bad" role="alert" style={{ marginTop: 12 }}>
              {err}
            </div>
          ) : null}
          {needsGuardian ? (
            <Command cmd={GUARDIAN_INIT_CMD}>
              <div style={{ marginBottom: 8 }}>The drill needs its own guardian wallet. Create it once, from the repo root:</div>
            </Command>
          ) : null}
          {state && state.status !== "idle" ? (
            <>
              <ol className="track" aria-label="Drill stages">
                {DRILL_STAGES.map((g, n) => {
                  const st = stageStatus(state, g);
                  return (
                    <li key={g} className={`track-stage ${st}`} aria-current={st === "active" ? "step" : undefined}>
                      <span className="track-mark" aria-hidden="true">
                        {STAGE_MARK[st] || n + 1}
                      </span>
                      <span className="track-label">
                        {g.charAt(0).toUpperCase() + g.slice(1)}
                        <span className="track-state">{STAGE_WORD[st]}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              {DRILL_STAGES.some((g) => stageStatus(state, g) === "failed") ? <div className="err">{state.error ?? "A stage failed."}</div> : null}
            </>
          ) : (
            <div className="empty">No drill running.</div>
          )}
          {state?.runId ? (
            <p className="caption" style={{ margin: "14px 0 0" }}>
              Run <CopyText text={state.runId} label="run id" />
            </p>
          ) : null}
          {state && state.lines.length > 0 ? (
            <details className="log">
              <summary>Log ({state.lines.length} lines)</summary>
              <pre className="mono">{state.lines.join("\n")}</pre>
            </details>
          ) : null}
        </section>

        {ended ? (
          <section className="card roomy">
            <h2>Verdict</h2>
            {(() => {
              const pass = verdict ? verdict.pass : state.status === "pass";
              return (
                <div className={`result ${pass ? "pass" : "fail"}`}>
                  <div className="result-word">{pass ? "Passed" : "Failed"}</div>
                  {verdict ? (
                    <dl className="result-stats">
                      <div>
                        <dt>Blocks to rescue</dt>
                        <dd>{verdict.blocks ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Value kept</dt>
                        <dd>{pct(verdict.keptPct)}</dd>
                      </div>
                    </dl>
                  ) : null}
                </div>
              );
            })()}
            {verdict && verdict.failures.length > 0 ? (
              <ul className="failures">
                {verdict.failures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : null}
            {!verdict ? (
              <p className="caption" style={{ margin: "12px 0 0" }}>
                No verdict file for this run{state.error ? `: ${state.error}` : ""}. The result above comes from the drill's own status.
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="card">
          <h2>Past runs</h2>
          {runs.length === 0 ? (
            <div className="empty">No runs yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="runs">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Date</th>
                    <th>Mode</th>
                    <th>Result</th>
                    <th className="num">Blocks</th>
                    <th className="num">Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.runId}>
                      <td className="run-id">
                        <CopyText text={r.runId} label="run id" />
                      </td>
                      <td className="run-date">{when(r.checkedAt)}</td>
                      <td className="run-mode">{r.mode === "drill" ? "Drill" : "Demo"}</td>
                      <td className="run-result">
                        <span className={`tag ${r.pass ? "safe" : "red"}`}>{r.pass ? "Passed" : "Failed"}</span>
                      </td>
                      <td className="num" data-label="Blocks">{r.blocks ?? "-"}</td>
                      <td className="num" data-label="Kept">{pct(r.keptPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
