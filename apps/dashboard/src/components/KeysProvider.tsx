import { clearPqcStatusCache } from "@qorechain/sdk";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Hex } from "viem";
import { appSession } from "../lib/appWallet";
import { readPqcStatus } from "../lib/chain";
import { errorText } from "../lib/format";
import { keysNeeded, type KeyNeed } from "../lib/keys";

type Keys = {
  /** Opens the unlock dialog if the session lacks what `need` asks for; true once it has it, false if cancelled. */
  requireKeys(need: KeyNeed): Promise<boolean>;
  unlocked: boolean;
  lock(): void;
};
const Ctx = createContext<Keys | null>(null);

export function useKeys(): Keys {
  const v = useContext(Ctx);
  if (!v) throw new Error("useKeys outside KeysProvider");
  return v;
}

const sessionHas = () => ({ classical: !!appSession.classical(), pqc: !!appSession.account() });

/** One unlock dialog for the whole app, opened by any action that signs. */
export function KeysProvider({ owner, children }: { owner: Hex | null; children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => !!appSession.classical());
  const [ask, setAsk] = useState<{ password: boolean; code: boolean } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => appSession.onChange(() => setUnlocked(!!appSession.classical())), []);

  const requireKeys = useCallback((need: KeyNeed) => {
    const n = keysNeeded(sessionHas(), need);
    if (!n.password && !n.code) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      // One dialog at a time: an earlier caller still waiting is told "cancelled" rather than left hanging.
      resolver.current?.(false);
      resolver.current = resolve;
      setAsk(n);
    });
  }, []);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setAsk(null);
  };

  return (
    <Ctx.Provider value={{ requireKeys, unlocked, lock: () => appSession.lock() }}>
      {children}
      {ask ? <UnlockDialog ask={ask} owner={owner} onDone={finish} /> : null}
    </Ctx.Provider>
  );
}

function UnlockDialog({ ask, owner, onDone }: { ask: { password: boolean; code: boolean }; owner: Hex | null; onDone: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (ask.password && !appSession.classical()) await appSession.unlock(pw);
      if (ask.code && !appSession.account()) {
        if (!owner) throw new Error("no wallet in this browser");
        clearPqcStatusCache();
        // Checked against the key registered on chain before anything is signed.
        appSession.providePqc(code, await readPqcStatus(owner));
      }
      onDone(true);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="unlock-dialog" aria-labelledby="unlock-title" onCancel={(e) => { e.preventDefault(); onDone(false); }}>
      <form onSubmit={(e) => void submit(e)} className="unlock-form">
        <h2 id="unlock-title">Unlock to sign</h2>
        <p className="hint">
          Once per session. {ask.password ? "Your password opens the wallet in this browser. " : ""}
          {ask.code ? "Your recovery code makes the key that signs. " : ""}Nothing leaves this tab.
        </p>
        {ask.password ? (
          <label className="field">
            Password
            <input className="input" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
        ) : null}
        {ask.code ? (
          <label className="field">
            Recovery code
            <input className="input mono" autoComplete="off" spellCheck={false} placeholder="QRC1-…" autoFocus={!ask.password} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        ) : null}
        {ask.code ? <p className="hint">Pasting from your password manager or the downloaded file works.</p> : null}
        {err ? <p className="err" role="alert">{err}</p> : null}
        <div className="actions">
          <button type="button" className="btn" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || (ask.password && !pw) || (ask.code && !code.trim())}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
