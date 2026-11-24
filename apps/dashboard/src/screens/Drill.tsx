import { useCallback, useEffect, useRef, useState } from "react";
import { CheckRow, Command, CopyText } from "../components/ui";
import { DRILL_STAGES, fetchDrill, fetchDrillRuns, stageStatus, startDrill, subscribeDrill, type DrillState, type VerdictFile } from "../lib/drill";
import { errorText } from "../lib/format";
import { useApp } from "../state";

/** The drill guardian setup command; run from the repo root (the CLI reads the root .env). */
const GUARDIAN_INIT_CMD = "pnpm cli drill-guardian init";

const MARK = { done: "pass", failed: "fail", active: "pending", pending: "pending" } as const;
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
        owner is not touched. One drill costs about 2 QOR of testnet funds from the funder.
      </p>
      {!online ? (
        <div className="banner warn" role="status">
          <strong>Agent offline: drills are off.</strong> Start it from the repo root with <span className="mono">pnpm agent</span>.
        </div>
      ) : null}
      <div className="row">
        <div className="stack" style={{ flex: "999 1 560px", minWidth: 0 }}>
          <section className="card">
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
                <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>The drill needs its own guardian wallet. Create it once, from the repo root:</div>
              </Command>
            ) : null}
            {state && state.status !== "idle" ? (
              <div className="checks" style={{ marginTop: 16 }}>
                {DRILL_STAGES.map((g) => {
                  const st = stageStatus(state, g);
                  return <CheckRow key={g} status={MARK[st]} title={g} detail={st === "active" ? "running" : st === "failed" ? (state.error ?? "failed") : undefined} />;
                })}
              </div>
            ) : (
              <div className="empty">No drill running.</div>
            )}
            {state?.runId ? (
              <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--muted)" }}>
                Run <CopyText text={state.runId} label="run id" />
              </p>
            ) : null}
            {state && state.lines.length > 0 ? (
              <details style={{ marginTop: 12 }}>
                <summary>Log ({state.lines.length} lines)</summary>
                <pre className="mono" style={{ fontSize: 12, overflow: "auto", maxHeight: 320, margin: "8px 0 0" }}>
                  {state.lines.join("\n")}
                </pre>
              </details>
            ) : null}
          </section>

          {ended ? (
            <section className="card">
              <div className="between">
                <h2>Verdict</h2>
                <span className={`tag ${(verdict ? verdict.pass : state.status === "pass") ? "blue" : "red"}`}>
                  {(verdict ? verdict.pass : state.status === "pass") ? "PASS" : "FAIL"}
                </span>
              </div>
              {verdict ? (
                <>
                  <dl className="kv">
                    <div>
                      <dt>Blocks to rescue</dt>
                      <dd>{verdict.blocks ?? "-"}</dd>
                    </div>
                    <div>
                      <dt>Kept</dt>
                      <dd>{pct(verdict.keptPct)}</dd>
                    </div>
                  </dl>
                  {verdict.failures.length > 0 ? (
                    <ul style={{ margin: "8px 0 0", fontSize: 13 }}>
                      {verdict.failures.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--muted)" }}>
                  No verdict file for this run{state.error ? `: ${state.error}` : ""}. The result above comes from the drill's own status.
                </p>
              )}
            </section>
          ) : null}
        </div>

        <aside className="side">
          <section className="card">
            <h2>Past runs</h2>
            {runs.length === 0 ? (
              <div className="empty">No runs yet.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table>
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
                        <td>
                          <CopyText text={r.runId} label="run id" />
                        </td>
                        <td>{when(r.checkedAt)}</td>
                        <td>{r.mode}</td>
                        <td>
                          <span className={`tag ${r.pass ? "blue" : "red"}`}>{r.pass ? "PASS" : "FAIL"}</span>
                        </td>
                        <td className="num">{r.blocks ?? "-"}</td>
                        <td className="num">{pct(r.keptPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
