import type { EvmWindow } from "@qorechain/evm/window";
import { useEffect, useRef, useState } from "react";
import { erc20Abi, getAbiItem, type Hex } from "viem";
import { HowItWorks, useHowItWorks } from "../components/HowItWorks";
import { GasTank } from "../components/GasTank";
import { RescueNow } from "../components/RescueNow";
import { TxHash, WindowCommand } from "../components/ui";
import { agentBase, fetchHealth, fetchPolicy, type Health as AgentHealth } from "../lib/agent";
import { publicClient, readSpendingRules, readWindow } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { ago, fmtAmount, fmtInt, shortAddr, tokenSymbol } from "../lib/format";
import { usePoll, type Polled } from "../lib/hooks";
import { big, incidentTag, triggerKind } from "../lib/incidents";
import { coverage, describeAgentRule, heroRescue, labelCounterparty, windowTargetsLabel } from "../lib/overview";
import { useOwnedIncidents } from "../lib/useOwned";
import { useApp } from "../state";
import { ACTIVITY_BLOCKS, readActivity, readAssets, SYMBOLS, type Activity, type AssetRow } from "../lib/ownerReads";

const SLOW_TEXT = "diana is slow to answer. Still trying…";
const WINDOW_TIP = "A time-limited permission your account opens for EVM transactions; while it is closed, a leaked ECDSA key can't send anything.";

/** Wrap the words "EVM window" in a hover explanation. */
function withTip(text: string) {
  const at = text.indexOf("EVM window");
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="tip" title={WINDOW_TIP}>
        EVM window
      </span>
      {text.slice(at + "EVM window".length)}
    </>
  );
}

const BLOCK_SECONDS = 1.4;

type Tone = "calm" | "open" | "rescued" | "unverified";

const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 10_000n) / total) / 100);

/**
 * The status board: what state the account is in (headline, EVM window) above the waterline, and each token's split
 * between the account (exposed) and the vault (safe) below it. Replaces the hero and the Protected assets card.
 */
function StatusBoard({ cfg, win: winPoll, health }: { cfg: AgentConfig; win: Polled<EvmWindow>; health: AgentHealth | undefined }) {
  const { verdictFor } = useApp();
  const win = winPoll.data;
  const winError = winPoll.error;
  const winSlow = winPoll.slow;
  // Only reports whose trigger tx came from this owner (or is still being checked): never the agent's word alone.
  const { own: incidents } = useOwnedIncidents();
  const [show, setShow] = useState<"close" | "open" | null>(null);
  const assets = usePoll(() => readAssets(cfg), 10_000, `${cfg.owner}/${cfg.vault}`);
  const reported = heroRescue(incidents, verdictFor);
  // "Your tokens are safe" only for a report verified against the chain (Review: never from the agent's word alone).
  const rescue = reported?.state === "safe" ? reported.incident : undefined;
  const doubt = reported && reported.state !== "safe" ? reported : undefined;
  const open = !!win?.live;

  // The one animation: a rescue detected while this page is open grows the vault part of the bars once the balances
  // are re-read. A rescue that predates the page (page load, tab switch) does not animate.
  const mountedAt = useRef(Date.now());
  const seenRescue = useRef<string | null>(null);
  const awaitingBalances = useRef(false);
  const [grow, setGrow] = useState(0);
  useEffect(() => {
    if (!rescue || seenRescue.current === rescue.id) return;
    seenRescue.current = rescue.id;
    if (Date.parse(rescue.detectedAt) >= mountedAt.current - 2_000) {
      awaitingBalances.current = true;
      assets.refresh();
    }
  }, [rescue?.id]);
  useEffect(() => {
    if (!awaitingBalances.current || assets.at === null) return;
    awaitingBalances.current = false;
    setGrow((g) => g + 1);
  }, [assets.at]);

  let status: string;
  let when: string | null = null;
  let title: string;
  let body: string;
  let tone: Tone = open ? "open" : "calm";
  if (rescue) {
    const t = rescue.trigger;
    const sym = tokenSymbol(cfg, t.token);
    const kept = rescue.rescues.filter((r) => r.success).map((r) => `${fmtAmount(big(r.amount))} ${tokenSymbol(cfg, r.token)}`);
    tone = "rescued";
    status = "Rescue completed";
    when = ago(rescue.detectedAt);
    title = "Your tokens are safe in your vault";
    body =
      triggerKind(rescue) === "approval"
        ? `At block #${fmtInt(String(t.block))} your ECDSA key approved ${shortAddr(t.to)}, a spender you don't trust, for ${sym}. The Guardian moved ${kept.join(", ")} into your vault. Treat that key as leaked.`
        : `At block #${fmtInt(String(t.block))} your ECDSA key sent ${fmtAmount(big(t.amount))} ${sym} to ${shortAddr(t.to)}, an address you don't trust. The Guardian moved ${kept.join(", ")} into your vault. Treat that key as leaked.`;
  } else if (doubt) {
    tone = doubt.state === "unverified" ? "unverified" : open ? "open" : "calm";
    status = doubt.state === "unverified" ? "Unverified rescue report" : "Checking a rescue report";
    when = doubt.state === "unverified" ? ago(doubt.incident.detectedAt) : null;
    title = doubt.state === "unverified" ? "The agent reports a rescue that did not verify" : "Checking the agent's rescue report…";
    body =
      doubt.state === "unverified"
        ? "Its report failed a check against the chain (signature, linked key or the rescue txs), so this page does not treat your tokens as safe. Open the report to see which check failed, and check your balances below."
        : "The agent reports a rescue. This page shows it as safe only once the signed report checks out against the chain.";
  } else if (open) {
    status = "Protected, the Guardian is watching";
    title = "Your EVM window is open";
    body =
      "While it is open, anyone holding your ECDSA key can send txs inside it. If a transfer goes to an address you don't trust, the Guardian moves your tokens into your vault within a block or two.";
  } else if (win) {
    status = "Protected, nothing exposed";
    title = "No exposure right now";
    body =
      "Your EVM window is closed, so a leaked ECDSA key can't move anything: native-lane txs need your hybrid signature. The Guardian stays armed for the next window you open.";
  } else {
    status = "Checking";
    title = winError ? "Can't read your EVM window" : "Reading your EVM window…";
    body = winError ? `diana REST did not answer: ${winError}. Retrying every 10 s.` : winSlow ? SLOW_TEXT : "One moment.";
  }

  const degraded = health && !health.ok ? `Guardian degraded: its last block was ${ago(health.lastBlockAt)}.` : null;

  const totalBlocks = win ? Number(win.expiryHeight - win.openedHeight) : 0;
  const blocksPct = win && totalBlocks > 0 ? Math.min(100, (Number(win.remainingBlocks) / totalBlocks) * 100) : 0;

  const rescueRows = assets.data
    ?.filter((a): a is AssetRow & { sym: (typeof SYMBOLS)[number]; allowance: bigint } => a.allowance !== null && (SYMBOLS as readonly string[]).includes(a.sym))
    .map((a) => ({ sym: a.sym, token: cfg.tokens[a.sym], owner: a.owner, allowance: a.allowance }));

  return (
    <section className={`board ${tone}`} aria-labelledby="board-title">
      <div className="board-top">
        <div className="board-main">
          <div className="board-status">
            <span className="st">{status}</span>
            {when ? <span className="when">{when}</span> : null}
            {degraded ? <span className="degraded">Guardian degraded</span> : null}
          </div>
          <h2 id="board-title" className="board-title">
            {withTip(title)}
          </h2>
          <p>{body}</p>
          {degraded ? <p className="slow">{degraded}</p> : null}
          <div className="actions">
            {open ? (
              <button type="button" className="btn primary" onClick={() => setShow(show === "close" ? null : "close")} aria-expanded={show === "close"}>
                Close EVM window now
              </button>
            ) : null}
            {!open && win && !rescue && !doubt ? (
              <button type="button" className="btn" onClick={() => setShow(show === "open" ? null : "open")} aria-expanded={show === "open"}>
                Open a scoped window
              </button>
            ) : null}
            {doubt ? (
              <a className="btn" href={`#/incidents/${encodeURIComponent(doubt.incident.id)}`}>
                View the report
              </a>
            ) : null}
            {rescue ? (
              <>
                <a className="btn primary" href={`#/incidents/${encodeURIComponent(rescue.id)}`}>
                  View signed report
                </a>
                <a className="btn" href="#/recover">
                  Recover funds
                </a>
              </>
            ) : null}
          </div>
          {show === "close" && open ? (
            <WindowCommand action="close" owner={cfg.owner}>
              Closing sends <span className="mono">MsgCloseEVMWindow</span>, a hybrid tx (ECDSA + your ML-DSA-87 key). No browser wallet can sign
              one on diana yet, so run this in the repo root. It takes effect in the same block.
            </WindowCommand>
          ) : null}
          {show === "open" && !open ? (
            <WindowCommand action="open" owner={cfg.owner}>
              Opens 1,800 blocks (~42 min) and 5 txs, scoped to fUSD, fETH, fBTC, your vault and the guardian. Its budget covers fees only (a QOR
              top-up of the guardian needs <span className="mono">--topup &lt;QOR&gt;</span>, see Gas tank). Keep it short; close it when you are done.
              Hybrid tx, so it runs from the CLI.
            </WindowCommand>
          ) : null}
        </div>
        <div className={`window-box${open ? " open" : ""}`}>
          <div className="lbl">
            Your{" "}
            <span className="tip" title={WINDOW_TIP}>
              EVM window
            </span>
          </div>
          <div className="value">
            {!win ? "…" : open ? `Open, ~${Math.max(1, Math.round((Number(win.remainingBlocks) * BLOCK_SECONDS) / 60))} min left` : "Closed"}
          </div>
          <div className="note">
            {!win
              ? ""
              : open
                ? `Scoped to ${windowTargetsLabel(win.allowedTargets, cfg)}. Closing it needs your hybrid signature (CLI).`
                : win.found
                  ? `Last window ${win.remainingTxs === 0n ? "used up its txs" : "expired"}. Open one only when you need the EVM lane.`
                  : "No window opened yet. Open one only when you need the EVM lane."}
          </div>
          {open && win ? (
            <>
              <div className="bar">
                <div style={{ width: `${blocksPct}%` }} />
              </div>
              <div className="counts">
                <span>
                  {fmtInt(win.remainingBlocks)} of {fmtInt(totalBlocks)} blocks left
                </span>
                <span>
                  {fmtInt(win.remainingTxs)} of {fmtInt(win.maxTxs)} txs left
                </span>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {rescue ? (
        <div className="do-next">
          <h3>Do next</h3>
          <ul>
            {[
              { t: "Close your EVM window", s: open ? "Stops the leaked key from sending more txs." : "Done. The key can't send anything now.", done: !open && !!win },
              { t: "Stop using this ECDSA key", s: "Move to a new account for future EVM use.", done: false },
              { t: "Recover to a safe address", s: "Sign with Guardian Signer, then submit.", done: false },
            ].map((x) => (
              <li key={x.t} className="check">
                <span className={`mark ${x.done ? "pass" : ""}`} aria-label={x.done ? "done" : "to do"}>
                  {x.done ? "✓" : "•"}
                </span>
                <div>
                  <div className="ct">{x.t}</div>
                  <div className="cs">{x.s}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="tide">
        <div className="tide-head">
          <h3>Where your tokens are</h3>
          <span className="lbl">
            EVM lane, vault <span className="mono">{shortAddr(cfg.vault)}</span>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th className="num">On your account</th>
              <th>
                <span className="sr-only">Split between account and vault</span>
              </th>
              <th className="num">In your vault</th>
              <th>Approval</th>
            </tr>
          </thead>
          <tbody>
            {assets.data ? (
              assets.data.map((a) => {
                const cov = a.allowance === null ? null : coverage(a.allowance);
                const vault = a.vault ?? 0n;
                const total = a.owner + vault;
                return (
                  <tr key={a.sym}>
                    <td className="sym">{a.sym}</td>
                    <td className={`amt owner${a.owner === 0n ? " zero" : ""}`}>{fmtAmount(a.owner)}</td>
                    <td className="split-cell">
                      {a.allowance === null ? (
                        <span className="qor-note">Not swept, window budget only</span>
                      ) : (
                        <div className="split" aria-hidden="true">
                          {a.owner > 0n ? <span className="acct" style={{ width: `${pct(a.owner, total)}%` }} /> : null}
                          {vault > 0n ? <span key={`${a.sym}-${grow}`} className={`vault${grow ? " grow" : ""}`} style={{ width: `${pct(vault, total)}%` }} /> : null}
                        </div>
                      )}
                    </td>
                    <td className={`amt vault${a.vault ? "" : " zero"}`}>{a.vault === null ? "—" : fmtAmount(a.vault)}</td>
                    <td className="cov">{cov ? <span className={`tag ${cov.tone}`}>{cov.text}</span> : null}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={5} className="empty">
                  {assets.error ? `Could not read balances: ${assets.error}` : assets.slow ? SLOW_TEXT : "Reading balances…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="tide-legend">
          <span>
            <i className="acct" aria-hidden="true" />
            On your account: a leaked key can reach it while your window is open
          </span>
          <span>
            <i className="vault" aria-hidden="true" />
            In your vault: only your ML-DSA-87 key opens it
          </span>
        </div>
      </div>

      <div className="board-foot">
        <RescueNow cfg={cfg} rows={rescueRows} win={winPoll} onSent={assets.refresh} />
      </div>
    </section>
  );
}

export function GuardianHealth({ cfg, win, health }: { cfg: AgentConfig; win: Polled<EvmWindow>; health: Polled<AgentHealth> }) {
  const { config } = useApp();
  const rules = usePoll(() => readSpendingRules(cfg.owner), 30_000, cfg.owner);
  const h = config.agentOnline ? health.data : undefined;
  const rule = rules.data ? describeAgentRule(rules.data, cfg.vault) : null;
  const channels = h ? Object.entries(h.alerts).filter(([, on]) => on).map(([n]) => (n === "telegram" ? "Telegram" : "Webhook")) : [];

  return (
    <>
      <section className="card">
        <h2>Guardian health</h2>
        <dl className="kv">
          <div>
            <dt>Agent</dt>
            <dd style={{ color: h?.ok ? "var(--safe)" : "var(--danger)", fontWeight: 600 }}>
              {!h ? "Offline" : h.ok ? "Online" : "Degraded"}
              {h ? (
                <small>
                  Block #{h.lastBlock ? fmtInt(h.lastBlock) : "?"}, {ago(h.lastBlockAt)}
                </small>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Guardian window</dt>
            <dd>
              {!h?.window ? (h?.windowRequired === false ? "Closed, on demand" : "Unknown") : h.window.live ? `${fmtInt(h.window.remainingBlocks)} blocks left` : "Closed"}
              {h?.window?.live ? (
                <small>
                  {fmtInt(h.window.remainingTxs)} txs left
                </small>
              ) : h?.windowRequired === false ? (
                <small>It opens just before yours, so the Guardian costs nothing while your account is closed</small>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Alerts</dt>
            <dd>{!h ? "—" : channels.length ? `${channels.join(", ")} on` : agentBase().owner ? "Not available yet" : "None set"}</dd>
          </div>
          <div>
            <dt>Its permission on your account</dt>
            <dd style={rule && !rule.ok ? { color: "var(--danger)" } : undefined}>
              {rule ? rule.text : rules.error ? "Could not read" : rules.slow ? SLOW_TEXT : "…"}
              <small>{rule?.ok ? "Enforced by the chain" : rule ? "Not the expected rule" : ""}</small>
            </dd>
          </div>
          <div>
            <dt>Who can withdraw</dt>
            <dd>Only your ML-DSA-87 key</dd>
          </div>
        </dl>
      </section>
      <GasTank cfg={cfg} health={h} win={win} />
    </>
  );
}

function LowerGrid({ cfg, win, health }: { cfg: AgentConfig; win: Polled<EvmWindow>; health: Polled<AgentHealth> }) {
  const { incidents } = useApp();
  const policy = usePoll(fetchPolicy, 15_000, "policy");
  const activity = usePoll(() => readActivity(cfg), 15_000, `${cfg.owner}/${Object.values(cfg.tokens).join()}`);
  const byHash = new Map(incidents.map((i) => [String(i.trigger?.hash ?? "").toLowerCase(), i]));

  return (
    <div className="ov-grid">
      <div className="stack">
        <section className="card">
          <h2>Outgoing activity</h2>
          <p className="caption">Every token transfer and approval from your account in the last {fmtInt(ACTIVITY_BLOCKS)} blocks</p>
          {activity.data?.items.length ? (
            activity.data.items.map((e) => {
              const who = labelCounterparty(e.to, cfg, policy.data);
              const sym = tokenSymbol(cfg, e.token);
              const inc = byHash.get(e.hash.toLowerCase());
              const tag = inc
                ? { text: incidentTag(inc) === "Rescue" ? "Rescue triggered" : "Alert", tone: "orange" }
                : who.trusted
                  ? { text: "Allowed", tone: "" }
                  : { text: "Not trusted", tone: "orange" };
              return (
                <div key={`${e.hash}/${e.logIndex}`} className="activity">
                  <span className="muted" style={{ fontSize: 13 }}>
                    Block {fmtInt(e.block)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="what">
                      {e.kind === "transfer" ? `Sent ${fmtAmount(e.amount)} ${sym} to ${who.label}` : `Approved ${fmtAmount(e.amount)} ${sym} for ${who.label}`}
                    </div>
                    <div className="meta wrap-any">
                      <span className="mono">{e.to}</span>, {who.trusted ? "trusted" : "not a trusted address"}
                    </div>
                    <div className="meta" style={{ marginTop: 2 }}>
                      Tx <TxHash hash={e.hash} />
                    </div>
                  </div>
                  {inc ? (
                    <a className={`tag ${tag.tone}`} href={`#/incidents/${encodeURIComponent(inc.id)}`}>
                      {tag.text}
                    </a>
                  ) : (
                    <span className={`tag ${tag.tone}`}>{tag.text}</span>
                  )}
                </div>
              );
            })
          ) : (
            <div className="empty">{activity.error ? `Could not read logs: ${activity.error}` : activity.data ? "Nothing sent from your account in this range." : activity.slow ? SLOW_TEXT : "Reading logs…"}</div>
          )}
        </section>

        <section className="card">
          <div className="between">
            <h2>Trusted wallets and apps</h2>
            <a href="#/rules" style={{ fontSize: 14, fontWeight: 600 }}>
              Manage
            </a>
          </div>
          <p className="caption" style={{ margin: "6px 0 12px" }}>
            A transfer or approval to anything else triggers a rescue. Add a recipient or dApp before you use it.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {policy.data?.trusted.map((t) => (
              <div key={t.address} className="trusted">
                <span style={{ fontWeight: 500 }}>
                  {t.label}
                  {t.kind === "app" ? <span className="kind">App</span> : null}
                </span>
                <span className="mono" style={{ color: "var(--harbour-2)" }} title={t.address}>
                  {shortAddr(t.address)}
                </span>
              </div>
            ))}
            <div className="trusted">
              <span style={{ fontWeight: 500 }}>Your vault</span>
              <span className="mono" style={{ color: "var(--harbour-2)" }} title={cfg.vault}>
                {shortAddr(cfg.vault)}
              </span>
            </div>
            {policy.error ? <div className="empty">Trusted list unavailable: {policy.error}</div> : null}
            {policy.data ? (
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
                A transfer of more than {fmtAmount(big(policy.data.maxOutbound))} fUSD, fETH or fBTC triggers a rescue even to a trusted wallet.
              </div>
            ) : null}
          </div>
        </section>
      </div>
      <div className="side">
        <GuardianHealth cfg={cfg} win={win} health={health} />
      </div>
    </div>
  );
}

export function Overview() {
  const { config } = useApp();
  const cfg = config.cfg;
  const win = usePoll(() => readWindow(cfg!.owner), 10_000, cfg ? cfg.owner : null);
  const health = usePoll(fetchHealth, 10_000, "health");
  const how = useHowItWorks();
  if (!cfg) return null;
  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        {!how.shown ? (
          <button type="button" className="btn small" onClick={how.reopen}>
            How it works
          </button>
        ) : null}
      </div>
      {how.shown ? <HowItWorks onDismiss={how.dismiss} /> : null}
      <StatusBoard cfg={cfg} win={win} health={config.agentOnline ? health.data : undefined} />
      <LowerGrid cfg={cfg} win={win} health={health} />
      <p className="ov-foot">Live data from the qorechain-diana testnet</p>
    </>
  );
}
