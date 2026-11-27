import type { Hex } from "viem";
import { ConfigCheckAlert } from "../components/ConfigCheckAlert";
import { TestProtection } from "../components/TestProtection";
import { fetchHealth } from "../lib/agent";
import { readWindow } from "../lib/chain";
import { heroState } from "../lib/dashboard";
import { describeIncident } from "../lib/explain";
import { ago, fmtAmount } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { incidentTag } from "../lib/incidents";
import { readAssets } from "../lib/ownerReads";
import { unseenIncident } from "../lib/seen";
import { useSeenIncident } from "../hooks/useSeen";
import { useApp } from "../state";
import { GuardianHealth } from "./Overview";

const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 10_000n) / total) / 100);

/** The protected owner's home: status first, then where the tokens are, the protection test and, folded, the details. */
export function Dashboard({ owner, paused }: { owner: Hex; paused: boolean }) {
  const { config, incidents, verdictFor } = useApp();
  const cfg = config.cfg;
  const [seen, markSeen] = useSeenIncident(owner);
  const unseen = unseenIncident(incidents, seen);
  const assets = usePoll(() => readAssets(cfg!), 10_000, cfg ? `${cfg.owner}/${cfg.vault}` : null);
  const win = usePoll(() => readWindow(owner), 10_000, owner);
  const health = usePoll(fetchHealth, 15_000, config.agentOnline ? "dash-health" : null);
  const hero = heroState({
    unseen,
    agentOnline: config.agentOnline,
    agentChecked: config.agentChecked,
    checkFailed: !!cfg && !!config.check && !config.check.ok,
    healthOk: config.agentOnline ? health.data?.ok : undefined,
    paused,
  });

  const v = unseen ? verdictFor(unseen) : undefined;
  const story = unseen ? describeIncident(unseen, cfg) : null;
  const safeTitle = !!unseen && incidentTag(unseen) === "Rescue" && v?.ok === true;

  return (
    <>
      <h1>Dashboard</h1>
      <ConfigCheckAlert />
      {hero === "incident" && unseen && story ? (
        // A verified rescue is the good outcome: calm tone, proof first. Orange and role="alert" stay for what still needs the owner.
        <section className={`dash-hero ${safeTitle ? "safe" : "alert"}`} role={safeTitle ? undefined : "alert"}>
          <div className="dash-eyebrow">
            <span className={safeTitle ? "dot" : "dot degraded"} aria-hidden="true" />
            {incidentTag(unseen) === "Rescue" ? "Rescue" : "Alert"} · {ago(unseen.detectedAt)}
            {v === undefined ? " · checking the report…" : v.ok ? " · report verified" : " · report did not verify"}
          </div>
          <h2>{safeTitle ? "Your tokens are safe in your vault" : story.headline}</h2>
          <p>
            {safeTitle ? `${story.headline}. ` : ""}
            {story.detail} If you didn't send this, your key may be leaked: withdraw your tokens to a fresh address.
          </p>
          <div className="actions">
            {safeTitle ? (
              <>
                <a className="btn primary" href={`#/activity/${unseen.id}`} onClick={() => markSeen(unseen.id)}>
                  See the signed report ✓
                </a>
                <a className="btn" href="#/vault">
                  Withdraw to a fresh address
                </a>
              </>
            ) : (
              <>
                <a className="btn rescue" href="#/vault">
                  Withdraw to a fresh address
                </a>
                <a className="btn" href={`#/activity/${unseen.id}`} onClick={() => markSeen(unseen.id)}>
                  See what happened
                </a>
              </>
            )}
            <button type="button" className="btn ghost" onClick={() => markSeen(unseen.id)}>
              Dismiss
            </button>
          </div>
        </section>
      ) : hero === "calm" ? (
        <section className="dash-hero safe">
          <div className="dash-eyebrow">
            <span className="dot" aria-hidden="true" />
            Protected
          </div>
          <h2>Your Guardian is watching</h2>
          <p>Any transfer from your account to an address you don't trust moves your tokens into your vault within a block or two.</p>
        </section>
      ) : hero === "check" ? (
        <section className="dash-hero alert">
          <div className="dash-eyebrow">
            <span className="dot bad" aria-hidden="true" />
            Vault check failed
          </div>
          <h2>Your Guardian's settings don't match your vault</h2>
          <p>
            The vault your Guardian serves does not name this account and this Guardian on chain, so its reports are marked unverified. Nothing in
            your vault can be withdrawn without your recovery code.
          </p>
        </section>
      ) : hero === "degraded" ? (
        <section className="dash-hero">
          <div className="dash-eyebrow">
            <span className="dot degraded" aria-hidden="true" />
            Guardian degraded
          </div>
          <h2>Your Guardian is running with a problem</h2>
          <p>It answers, but its last health check failed, so a rescue may be late. Technical details below show what it reports.</p>
        </section>
      ) : hero === "paused" ? (
        <section className="dash-hero">
          <div className="dash-eyebrow">
            <span className="dot off" aria-hidden="true" />
            Paused
          </div>
          <h2>Your Guardian is paused</h2>
          <p>
            The service paused it after 7 days without activity. It starts again the next time you run the protection test or withdraw from your
            vault.
          </p>
        </section>
      ) : hero === "loading" ? (
        <section className="dash-hero">
          <div className="dash-eyebrow">
            <span className="dot off" aria-hidden="true" />
            Checking
          </div>
          <h2>Checking your Guardian…</h2>
          <p>Balances below are read live from the chain.</p>
        </section>
      ) : (
        <section className="dash-hero">
          <div className="dash-eyebrow">
            <span className="dot off" aria-hidden="true" />
            Guardian not answering
          </div>
          <h2>Your Guardian is not answering right now</h2>
          <p>Balances below are read live from the chain. Incidents and health come back when your Guardian does.</p>
        </section>
      )}

      <div className="row">
        <div className="stack grow">
          <section className="card">
            <div className="between">
              <h2>Your tokens</h2>
              <span className="dash-hint">orange: on your account · green: in your vault</span>
            </div>
            {!cfg ? (
              <p className="dash-hint">Reading your vault…</p>
            ) : !assets.data ? (
              <p className="dash-hint">{assets.error ? `Could not read balances: ${assets.error}` : "Reading balances…"}</p>
            ) : (
              <ul className="dash-tokens">
                {assets.data
                  .filter((a) => a.sym !== "QOR")
                  .map((a) => {
                    const vault = a.vault ?? 0n;
                    const total = a.owner + vault;
                    return (
                      <li key={a.sym}>
                        <b>{a.sym}</b>
                        <span className="mono">Account {fmtAmount(a.owner)}</span>
                        <span className="mono safe">Vault {fmtAmount(vault)}</span>
                        <span className="dash-bar" aria-hidden="true">
                          <i className="a" style={{ width: `${pct(a.owner, total)}%` }} />
                          <i className="v" style={{ width: `${pct(vault, total)}%` }} />
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </section>
          <section className="card">
            <div className="between">
              <h2>Latest activity</h2>
              <a href="#/activity">See all</a>
            </div>
            {incidents.length ? (
              <ul className="dash-latest">
                {incidents.slice(0, 3).map((i) => (
                  <li key={i.id}>
                    <a href={`#/activity/${i.id}`} onClick={() => i.id === unseen?.id && markSeen(i.id)}>
                      <span className={`tag ${incidentTag(i) === "Rescue" ? "orange" : ""}`}>{incidentTag(i)}</span>
                      <span className="dash-latest-text">{describeIncident(i, cfg).headline}</span>
                      <span className="dash-hint">{ago(i.detectedAt)} ›</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dash-empty">No incidents yet. Run the protection test to see one.</p>
            )}
          </section>
        </div>
        <div className="side">
          <TestProtection owner={owner} showWithdraw={hero !== "incident"} />
          <section className="card">
            <details className="dash-tech">
              <summary>Technical details</summary>
              {cfg ? (
                <div className="stack" style={{ marginTop: 12 }}>
                  <GuardianHealth cfg={cfg} win={win} health={health} />
                </div>
              ) : (
                <p className="dash-hint">Your Guardian's details appear once it answers.</p>
              )}
            </details>
          </section>
        </div>
      </div>
    </>
  );
}
