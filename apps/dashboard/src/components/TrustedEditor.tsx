import { useRef, useState } from "react";
import { AGENT_URL, fetchPolicy, putPolicy, type Policy } from "../lib/agent";
import { explorerAddress } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { errorText } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { addTrusted, latestPolicy, removeTrusted, type PolicyAt } from "../lib/rules";
import { ExtLink } from "./ui";

const EMPTY_FORM = { label: "", address: "", kind: "wallet" as "wallet" | "app" };

function FixedRow({ label, address, note }: { label: string; address: string; note: string }) {
  return (
    <div className="trusted" style={{ alignItems: "center" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>
          {label} <span className="tag safe">{note}</span>
        </div>
        <div className="mono wrap-any" style={{ fontSize: 12, color: "var(--harbour-2)", marginTop: 2 }}>
          <ExtLink href={explorerAddress(address)}>{address}</ExtLink>
        </div>
      </div>
    </div>
  );
}

/**
 * The agent's policy and its writes, shared by Rules and Protect. `online`: the agent answers (editing is off otherwise).
 * Each PUT bumps `gen`; a read is tagged with the generation current when it STARTED, so a poll that was in flight
 * during a PUT never replaces the PUT's answer (each write replaces the whole policy: building on an older read would
 * drop the previous edit).
 */
export function usePolicyEditor(online: boolean) {
  const gen = useRef(0);
  const policy = usePoll(async (): Promise<PolicyAt> => {
    const g = gen.current;
    return { p: await fetchPolicy(), gen: g };
  }, 15_000, "policy");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The agent's answer to the last write, used until a poll started after it lands.
  const [saved, setSaved] = useState<PolicyAt | null>(null);

  const current = latestPolicy(policy.data, saved);
  const canEdit = online && !!current && !busy;

  async function save(next: Policy, what: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const p = await putPolicy(next);
      gen.current += 1;
      setSaved({ p, gen: gen.current });
      setNotice(what);
      policy.refresh();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** A refusal made before anything was sent (a bad form value). */
  function fail(message: string) {
    setNotice(null);
    setError(message);
  }

  return { policy, current, canEdit, busy, error, notice, save, fail };
}
export type PolicyEditor = ReturnType<typeof usePolicyEditor>;

/** The error / notice line of the last write. */
export function EditorMessages({ editor }: { editor: PolicyEditor }) {
  return (
    <>
      {editor.error ? (
        <div className="err" role="alert">
          {editor.error}
        </div>
      ) : null}
      {editor.notice ? (
        <div className="ok-note" role="status">
          {editor.notice}
        </div>
      ) : null}
    </>
  );
}

/** The trusted wallets and apps: the list, the always-trusted vault and guardian, and the add form. */
export function TrustedEditor({ cfg, editor }: { cfg: Pick<AgentConfig, "owner" | "vault" | "guardian">; editor: PolicyEditor }) {
  const { current, canEdit, policy, save, fail } = editor;
  const [form, setForm] = useState(EMPTY_FORM);

  async function add() {
    if (!current) return;
    let next: Policy;
    try {
      next = addTrusted(current, form, cfg);
    } catch (e) {
      return fail(errorText(e));
    }
    if (await save(next, `Added ${form.label.trim()}.`)) setForm(EMPTY_FORM);
  }

  return (
    <section className="card">
      <h2>Trusted wallets and apps</h2>
      <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
        Transfers (up to the threshold) and approvals to these never trigger a rescue. Add a recipient or dApp before you use it. Edits go to the agent
        at <span className="mono">{AGENT_URL}</span>, which accepts them only from this machine (loopback, this dashboard's origin).
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {current?.trusted.map((t) => (
          <div key={t.address} className="trusted" style={{ alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>
                {t.label}
                <span className="kind">{t.kind === "app" ? "App" : "Wallet"}</span>
              </div>
              <div className="mono wrap-any" style={{ fontSize: 12, color: "var(--harbour-2)", marginTop: 2 }}>
                <ExtLink href={explorerAddress(t.address)}>{t.address}</ExtLink>
              </div>
            </div>
            <button
              type="button"
              className="btn small"
              disabled={!canEdit}
              aria-label={`Remove ${t.label}`}
              onClick={() => void save(removeTrusted(current, t.address), `Removed ${t.label}.`)}
            >
              Remove
            </button>
          </div>
        ))}
        {current && !current.trusted.length ? <div className="empty">Nothing trusted yet besides your vault and the guardian.</div> : null}
        {!current ? <div className="empty">{policy.error ? `Trusted list unavailable: ${policy.error}` : "Reading the trusted list…"}</div> : null}
        <FixedRow label="Your vault" address={cfg.vault} note="Always trusted" />
        <FixedRow label="Guardian" address={cfg.guardian} note="Always trusted" />
      </div>

      <form
        className="form"
        style={{ marginTop: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label style={{ flex: "1 1 140px" }}>
          Label
          <input className="input" value={form.label} maxLength={64} disabled={!canEdit} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </label>
        <label style={{ flex: "3 1 280px" }}>
          Address
          <input
            className="input mono"
            value={form.address}
            placeholder="0x…"
            spellCheck={false}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </label>
        <label style={{ flex: "0 1 110px" }}>
          Kind
          <select className="input" value={form.kind} disabled={!canEdit} onChange={(e) => setForm({ ...form, kind: e.target.value as "wallet" | "app" })}>
            <option value="wallet">Wallet</option>
            <option value="app">App</option>
          </select>
        </label>
        <button type="submit" className="btn primary small" disabled={!canEdit}>
          Add
        </button>
      </form>
    </section>
  );
}
