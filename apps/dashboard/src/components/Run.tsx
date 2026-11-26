import { errorText } from "../lib/format";
import { TxHash } from "./ui";

/** One action: idle, busy with its current step, or finished with the tx hashes it sent. */
export type Run =
  | { state: "idle" }
  | { state: "busy"; step: string; hashes: string[] }
  | { state: "done"; message: string; hashes: string[] }
  | { state: "error"; message: string; hashes: string[] };
export const IDLE: Run = { state: "idle" };

export function RunView({ run }: { run: Run }) {
  if (run.state === "idle") return null;
  return (
    <div style={{ marginTop: 10 }}>
      {run.state === "error" ? <div className="err">{run.message}</div> : null}
      {run.state === "done" ? <div className="ok-note">{run.message}</div> : null}
      {run.state === "busy" ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }} role="status">
          {run.step}
        </div>
      ) : null}
      {run.hashes.map((h) => (
        <div key={h} style={{ fontSize: 12, color: "var(--harbour-2)", marginTop: 4 }}>
          tx <TxHash hash={h} full />
        </div>
      ))}
    </div>
  );
}

/** Run `f`, tracking progress in `set`; `f` reports steps and hashes through `busy`. */
export async function track(set: (r: Run) => void, f: (busy: (step: string) => void, hashes: string[]) => Promise<string>) {
  const hashes: string[] = [];
  const busy = (step: string) => set({ state: "busy", step, hashes: [...hashes] });
  try {
    busy("Starting…");
    const message = await f(busy, hashes);
    set({ state: "done", message, hashes: [...hashes] });
  } catch (e) {
    set({ state: "error", message: errorText(e), hashes: [...hashes] });
  }
}
