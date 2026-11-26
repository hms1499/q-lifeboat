import { useState } from "react";
import { formatUnits } from "viem";
import { EditorMessages, TrustedEditor, usePolicyEditor } from "../components/TrustedEditor";
import { TurnOff } from "../components/TurnOff";
import { agentBase, fetchHealth, type Policy } from "../lib/agent";
import { appSession, hosted } from "../lib/appWallet";

import { errorText, fmtAmount } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { big } from "../lib/incidents";
import { describeRuleDetail, parseQorAmount } from "../lib/rules";
import { readSpendingRules } from "../lib/chain";
import { useApp } from "../state";

export function Rules() {
  const { config } = useApp();
  const cfg = config.cfg;
  const hostedOwner = agentBase().owner;
  // Hosted: every policy write carries the owner's ML-DSA signature (the gateway refuses anything else).
  const hostedKeys = !hostedOwner || !!appSession.account();
  const sign = hostedOwner ? (p: Policy) => hosted.signed("policy", p) : undefined;
  const editor = usePolicyEditor(config.agentOnline && hostedKeys, sign);
  const { current, canEdit, save, fail } = editor;
  const health = usePoll(fetchHealth, 15_000, "health");
  const rules = usePoll(() => readSpendingRules(cfg!.owner), 30_000, cfg ? cfg.owner : null);
  const [threshold, setThreshold] = useState<string | null>(null);

  if (!cfg) return null;
  const online = config.agentOnline;
  const h = online ? health.data : undefined;

  async function saveThreshold() {
    if (!current || threshold === null) return;
    let maxOutbound: string;
    try {
      maxOutbound = parseQorAmount(threshold);
    } catch (e) {
      return fail(errorText(e));
    }
    if (await save({ ...current, maxOutbound }, `Largest trusted transfer set to ${fmtAmount(BigInt(maxOutbound), 6)} tokens.`)) setThreshold(null);
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
          <strong>{hostedOwner ? "Your Guardian is not answering: editing is off." : "Agent offline: editing is off."}</strong>{" "}
          {hostedOwner ? (
            "The trusted list and the transfer limit live with your Guardian. Try again in a minute."
          ) : (
            <>
              The trusted list and threshold live in the agent. Start it from the repo root with <span className="mono">pnpm agent</span>.
            </>
          )}
        </div>
      ) : null}
      <div className="row">
        <div className="stack grow">
          <TrustedEditor cfg={cfg} editor={editor} />

          <section className="card">
            <h2>Largest trusted transfer</h2>
            <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              A transfer of more than this many tokens (fUSD, fETH or fBTC) triggers a rescue even to a trusted wallet. 0 means every transfer
              does.
              {current ? (
                <>
                  {" "}
                  Now: <strong>{fmtAmount(big(current.maxOutbound), 6)} per transfer</strong>.
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
                Tokens per transfer
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
          <EditorMessages editor={editor} />
        </div>

        <aside className="side">
          <section className="card">
            <h2>Alert channels</h2>
            {hostedOwner ? (
              <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
                Alerts by Telegram or email are not available on the public instance yet. Every rescue shows on{" "}
                <a href="#/overview">Overview</a> and <a href="#/incidents">Incidents</a> with its signed report.
              </p>
            ) : (
              <>
                <dl className="kv">
                  <div>
                    <dt>Telegram</dt>
                    <dd>{!h ? "—" : h.alerts.telegram ? "On" : "Off"}</dd>
                  </div>
                  <div>
                    <dt>Webhook</dt>
                    <dd>{!h ? "—" : h.alerts.webhook ? "On" : "Off"}</dd>
                  </div>
                </dl>
                <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
                  Read only. They are set in the agent's <span className="mono">.env</span> (<span className="mono">TELEGRAM_BOT_TOKEN</span>,{" "}
                  <span className="mono">TELEGRAM_CHAT_ID</span>, the webhook URL) because they hold secrets.
                </p>
              </>
            )}
          </section>
          <section className="card">
            <div className="between">
              <h2>The Guardian's permission</h2>
              <span className="tag safe">Enforced by the chain</span>
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              The spending rule on your account that bounds the agent's linked key, read from diana. Read only here.
            </p>
            {detail ? (
              <dl className="kv">
                {detail.map((r) => (
                  <div key={r.k}>
                    <dt>{r.k}</dt>
                    <dd className="wrap-any" style={r.ok === false ? { color: "var(--danger)" } : r.ok ? { color: "var(--safe)" } : undefined}>
                      {r.v}
                      {r.ok !== undefined ? <small>{r.ok ? "Matches the hard rule" : "Not the expected rule"}</small> : null}
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
      {hostedOwner ? null : <TurnOff cfg={cfg} />}
    </>
  );
}
