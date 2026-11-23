import { useRef, useState } from "react";
import { formatUnits } from "viem";
import { ExtLink } from "../components/ui";
import { AGENT_URL, fetchHealth, fetchPolicy, putPolicy, type Policy } from "../lib/agent";
import { explorerAddress, readSpendingRules } from "../lib/chain";
import { errorText, fmtAmount } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { big } from "../lib/incidents";
import { addTrusted, describeRuleDetail, latestPolicy, parseQorAmount, removeTrusted, type PolicyAt } from "../lib/rules";
import { useApp } from "../state";

const EMPTY_FORM = { label: "", address: "", kind: "wallet" as "wallet" | "app" };

function FixedRow({ label, address, note }: { label: string; address: string; note: string }) {
  return (
    <div className="trusted" style={{ alignItems: "center" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>
          {label} <span className="tag blue">{note}</span>
        </div>
        <div className="mono wrap-any" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
          <ExtLink href={explorerAddress(address)}>{address}</ExtLink>
        </div>
      </div>
    </div>
  );
}

export function Rules() {
  const { config } = useApp();
  const cfg = config.cfg;
  // Each PUT bumps `gen`; a read is tagged with the generation current when it STARTED, so a poll that was in flight
  // during a PUT never replaces the PUT's answer (each write replaces the whole policy: building on an older read would
  // drop the previous edit).
  const gen = useRef(0);
  const policy = usePoll(async (): Promise<PolicyAt> => {
    const g = gen.current;
    return { p: await fetchPolicy(), gen: g };
  }, 15_000, "policy");
  const health = usePoll(fetchHealth, 15_000, "health");
  const rules = usePoll(() => readSpendingRules(cfg!.owner), 30_000, cfg ? cfg.owner : null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [threshold, setThreshold] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The agent's answer to the last write, used until a poll started after it lands.
  const [saved, setSaved] = useState<PolicyAt | null>(null);

  if (!cfg) return null;
  const current = latestPolicy(policy.data, saved);
  const online = config.agentOnline;
  const canEdit = online && !!current && !busy;
  const h = online ? health.data : undefined;

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

  async function add() {
    if (!current || !cfg) return;
    let next: Policy;
    try {
      next = addTrusted(current, form, cfg);
    } catch (e) {
      setNotice(null);
      return setError(errorText(e));
    }
    if (await save(next, `Added ${form.label.trim()}.`)) setForm(EMPTY_FORM);
  }

  async function saveThreshold() {
    if (!current || threshold === null) return;
    let maxOutbound: string;
    try {
      maxOutbound = parseQorAmount(threshold);
    } catch (e) {
      setNotice(null);
      return setError(errorText(e));
    }
    if (await save({ ...current, maxOutbound }, `Threshold set to ${fmtAmount(BigInt(maxOutbound), 6)} QOR.`)) setThreshold(null);
  }

  const detail = rules.data ? describeRuleDetail(rules.data, cfg.vault) : null;

  return (
    <>
      <h1>Rules</h1>
      <p className="lead">
        What the Guardian treats as normal. A transfer or approval from your account to anything else, or above the threshold, triggers a rescue into
        your vault.
      </p>
      {!online ? (
        <div className="banner warn" role="status">
          <strong>Agent offline: editing is off.</strong> The trusted list and threshold live in the agent. Start it from the repo root with{" "}
          <span className="mono">pnpm agent</span>.
        </div>
      ) : null}
      <div className="row">
        <div className="stack" style={{ flex: "999 1 560px", minWidth: 0 }}>
          <section className="card">
            <h2>Trusted wallets and apps</h2>
            <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              Transfers (up to the threshold) and approvals to these never trigger a rescue. Add a recipient or dApp before you use it. Edits go to the
              agent at <span className="mono">{AGENT_URL}</span>, which accepts them only from this machine (loopback, this dashboard's origin).
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {current?.trusted.map((t) => (
                <div key={t.address} className="trusted" style={{ alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>
                      {t.label}
                      <span className="kind">{t.kind === "app" ? "APP" : "WALLET"}</span>
                    </div>
                    <div className="mono wrap-any" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
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
              <FixedRow label="Your vault" address={cfg.vault} note="always trusted" />
              <FixedRow label="Guardian" address={cfg.guardian} note="always trusted" />
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

          <section className="card">
            <h2>Transfer threshold</h2>
            <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              A transfer above this triggers a rescue even to a trusted wallet. 0 means every transfer does.
              {current ? (
                <>
                  {" "}
                  Now: <strong>{fmtAmount(big(current.maxOutbound), 6)} QOR</strong>.
                </>
              ) : null}
            </p>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveThreshold();
              }}
            >
              <label style={{ flex: "1 1 160px" }}>
                Threshold (QOR)
                <input
                  className="input mono"
                  inputMode="decimal"
                  disabled={!canEdit}
                  value={threshold ?? (current ? formatUnits(big(current.maxOutbound), 18) : "")}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </label>
              <button type="submit" className="btn primary small" disabled={!canEdit || threshold === null}>
                Save
              </button>
            </form>
          </section>
          {error ? (
            <div className="err" role="alert">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="ok-note" role="status">
              {notice}
            </div>
          ) : null}
        </div>

        <aside className="side">
          <section className="card">
            <h2>Alert channels</h2>
            <dl className="kv">
              <div>
                <dt>Telegram</dt>
                <dd>{!h ? "—" : h.alerts.telegram ? "on" : "off"}</dd>
              </div>
              <div>
                <dt>Webhook</dt>
                <dd>{!h ? "—" : h.alerts.webhook ? "on" : "off"}</dd>
              </div>
            </dl>
            <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              Read only. They are set in the agent's <span className="mono">.env</span> (<span className="mono">TELEGRAM_BOT_TOKEN</span>,{" "}
              <span className="mono">TELEGRAM_CHAT_ID</span>, the webhook URL) because they hold secrets.
            </p>
          </section>
          <section className="card">
            <div className="between">
              <h2>The Guardian's permission</h2>
              <span className="tag blue">enforced by the chain</span>
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              The spending rule on your account that bounds the agent's linked key, read from diana. Read only here.
            </p>
            {detail ? (
              <dl className="kv">
                {detail.map((r) => (
                  <div key={r.k}>
                    <dt>{r.k}</dt>
                    <dd className="wrap-any" style={r.ok === false ? { color: "var(--orange)" } : r.ok ? { color: "var(--blue)" } : undefined}>
                      {r.v}
                      {r.ok !== undefined ? <small>{r.ok ? "matches the Hard rule" : "not the expected rule"}</small> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="empty">{rules.error ? `Could not read the rule: ${rules.error}` : "Reading…"}</div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
