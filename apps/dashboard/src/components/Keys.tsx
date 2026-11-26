import type { PqcStatus } from "@qorechain/sdk";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { appSession } from "../lib/appWallet";
import { errorText } from "../lib/format";
import { loadSeed, type EncryptedSeed } from "../lib/keystore";
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

export function Hint({ children }: { children: ReactNode }) {
  return <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>{children}</p>;
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

/** Password form: unlock the wallet stored in this browser. */
export function UnlockForm({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [run, setRun] = useState<Run>(IDLE);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await track(setRun, async (busy) => {
      busy("Unlocking…");
      await appSession.unlock(pw);
      setPw("");
      onDone();
      return "Unlocked.";
    });
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)} style={{ marginTop: 12 }}>
      <Hint>Your wallet is locked. Enter the password you chose when you created it.</Hint>
      <label>
        Password
        <input className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={!pw || run.state === "busy"}>
          Unlock
        </button>
      </div>
      <RunView run={run} />
    </form>
  );
}

/** Recovery code form: derive the post-quantum key for this session, checked against the key on chain. */
export function CodeEntry({ pqc, onDone, why, extra }: { pqc: PqcStatus | undefined; onDone: () => void; why: string; extra?: ReactNode }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!pqc) return;
    try {
      // Refuses a mistyped code, or one whose key differs from the one registered on chain, before anything is signed.
      appSession.providePqc(code, pqc);
      setCode("");
      setErr(null);
      onDone();
    } catch (x) {
      setErr(errorText(x));
    }
  }
  return (
    <form className="form" onSubmit={submit} style={{ marginTop: 12 }}>
      <Hint>{why}</Hint>
      <label>
        Recovery code
        <input className="input mono" autoComplete="off" spellCheck={false} placeholder="QRC1-…" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={!code.trim() || !pqc}>
          {pqc ? "Use this code" : "Reading your key on chain…"}
        </button>
      </div>
      {err ? <div className="err">{err}</div> : null}
      {extra}
    </form>
  );
}

/** Signing steps need the unlocked wallet AND the post-quantum key from the recovery code. */
export function NeedKeys({ pqc, onChange, children }: { pqc: PqcStatus | undefined; onChange: () => void; children: ReactNode }) {
  if (!appSession.classical()) return <UnlockForm onDone={onChange} />;
  if (!appSession.account()) {
    return <CodeEntry pqc={pqc} onDone={onChange} why="This step is signed with your post-quantum key. Type your recovery code: it stays in this tab's memory and is never stored." />;
  }
  return <>{children}</>;
}


/** The in-app wallet stored in this browser (encrypted); undefined while reading, null when there is none. */
export function useStoredSeed(): EncryptedSeed | null | undefined {
  const [s, set] = useState<EncryptedSeed | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadSeed()
      .then((e) => live && set(e))
      .catch(() => live && set(null));
    return () => {
      live = false;
    };
  }, []);
  return s;
}
