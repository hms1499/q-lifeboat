import type { Incident } from "@qday/core";
import type { EvmWindow } from "@qorechain/evm/window";
import { useState } from "react";
import { erc20Abi, getAbiItem, type Hex } from "viem";
import { Command, ExtLink } from "../components/ui";
import { fetchHealth, fetchPolicy } from "../lib/agent";
import { explorerTx, publicClient, readSpendingRules, readWindow } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { ago, fmtAmount, fmtInt, shortAddr, tokenSymbol } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { big, incidentTag, triggerKind } from "../lib/incidents";
import { coverage, describeAgentRule, labelCounterparty, windowTargetsLabel } from "../lib/overview";
import { useApp } from "../state";

const SYMBOLS = ["fUSD", "fETH", "fBTC"] as const;
const ACTIVITY_BLOCKS = 2000n;
const BLOCK_SECONDS = 1.4;
/** A rescue this recent turns the banner into "your tokens are safe". */
const RECENT_RESCUE_MS = 30 * 60_000;

type AssetRow = { sym: string; owner: bigint; vault: bigint | null; allowance: bigint | null };

async function readAssets(cfg: AgentConfig): Promise<AssetRow[]> {
  const rows = await Promise.all(
    SYMBOLS.map(async (sym) => {
      const address = cfg.tokens[sym];
      const [owner, vault, allowance] = await Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [cfg.owner] }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [cfg.vault] }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "allowance", args: [cfg.owner, cfg.vault] }),
      ]);
      return { sym, owner, vault, allowance };
    }),
  );
  const [qorOwner, qorVault] = await Promise.all([publicClient.getBalance({ address: cfg.owner }), publicClient.getBalance({ address: cfg.vault })]);
  return [...rows, { sym: "QOR", owner: qorOwner, vault: qorVault, allowance: null }];
}

type Activity = { kind: "transfer" | "approval"; block: bigint; hash: Hex; logIndex: number; token: Hex; to: Hex; amount: bigint };

const TRANSFER = getAbiItem({ abi: erc20Abi, name: "Transfer" });
const APPROVAL = getAbiItem({ abi: erc20Abi, name: "Approval" });

/** The owner's token Transfer / Approval logs over the last 2,000 blocks (eth_getLogs with an indexed-topic filter). */
async function readActivity(cfg: AgentConfig): Promise<{ tip: bigint; items: Activity[] }> {
  const tip = await publicClient.getBlockNumber();
  const fromBlock = tip > ACTIVITY_BLOCKS ? tip - ACTIVITY_BLOCKS : 0n;
  const address = Object.values(cfg.tokens);
  const [transfers, approvals] = await Promise.all([
    publicClient.getLogs({ address, event: TRANSFER, args: { from: cfg.owner }, fromBlock, toBlock: tip }),
    publicClient.getLogs({ address, event: APPROVAL, args: { owner: cfg.owner }, fromBlock, toBlock: tip }),
  ]);
  const items: Activity[] = [
    ...transfers.map((l) => ({ kind: "transfer" as const, block: l.blockNumber, hash: l.transactionHash, logIndex: l.logIndex, token: l.address, to: l.args.to!, amount: l.args.value! })),
    ...approvals.map((l) => ({ kind: "approval" as const, block: l.blockNumber, hash: l.transactionHash, logIndex: l.logIndex, token: l.address, to: l.args.spender!, amount: l.args.value! })),
  ];
  items.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
  return { tip, items: items.slice(0, 25) };
}

function latestRescue(incidents: Incident[]): Incident | undefined {
  const i = incidents.find((x) => incidentTag(x) === "Rescue" && x.rescues.some((r) => r.success));
  return i && Date.now() - Date.parse(i.detectedAt) < RECENT_RESCUE_MS ? i : undefined;
}

function Hero({ cfg, win, winError }: { cfg: AgentConfig; win: EvmWindow | undefined; winError: string | null }) {
  const { incidents } = useApp();
  const [show, setShow] = useState<"close" | "open" | null>(null);
  const rescue = latestRescue(incidents);
  const open = !!win?.live;

  let kicker: string;
  let title: string;
  let body: string;
  let tone = open ? "open" : "";
  if (rescue) {
    const t = rescue.trigger;
    const sym = tokenSymbol(cfg, t.token);
    const kept = rescue.rescues.filter((r) => r.success).map((r) => `${fmtAmount(big(r.amount))} ${tokenSymbol(cfg, r.token)}`);
    tone = "rescued";
    kicker = `Rescue completed · ${ago(rescue.detectedAt)}`;
    title = "Your tokens are safe in your vault";
    body =
      triggerKind(rescue) === "approval"
        ? `At block #${fmtInt(String(t.block))} your ECDSA key approved ${shortAddr(t.to)}, a spender you don't trust, for ${sym}. The Guardian moved ${kept.join(", ")} into your vault. Treat that key as leaked.`
        : `At block #${fmtInt(String(t.block))} your ECDSA key sent ${fmtAmount(big(t.amount))} ${sym} to ${shortAddr(t.to)}, an address you don't trust. The Guardian moved ${kept.join(", ")} into your vault. Treat that key as leaked.`;
  } else if (open) {
    kicker = "Protected · Guardian is watching";
    title = "Your EVM window is open";
    body =
      "While it is open, anyone holding your ECDSA key can send txs inside it. If a transfer goes to an address you don't trust, the Guardian moves your tokens into your vault within a block or two.";
  } else if (win) {
    kicker = "Protected · nothing exposed";
    title = "No exposure right now";
    body =
      "Your EVM window is closed, so a leaked ECDSA key can't move anything: native-lane txs need your hybrid signature. The Guardian stays armed for the next window you open.";
  } else {
    kicker = "Checking";
    title = winError ? "Can't read your EVM window" : "Reading your EVM window…";
    body = winError ? `diana REST did not answer: ${winError}. Retrying every 10 s.` : "One moment.";
  }

  const totalBlocks = win ? Number(win.expiryHeight - win.openedHeight) : 0;
  const blocksPct = win && totalBlocks > 0 ? Math.min(100, (Number(win.remainingBlocks) / totalBlocks) * 100) : 0;

  return (
    <section className={`hero ${tone}`}>
      <div className="hero-grid">
        <div style={{ flex: "1 1 520px", minWidth: 0 }}>
          <div className="kicker">{kicker}</div>
          <h1>{title}</h1>
          <p>{body}</p>
          <div className="actions">
            {open ? (
              <button type="button" className="btn dark" onClick={() => setShow(show === "close" ? null : "close")} aria-expanded={show === "close"}>
                Close EVM window now
              </button>
            ) : null}
            {!open && win && !rescue ? (
              <button type="button" className="btn" onClick={() => setShow(show === "open" ? null : "open")} aria-expanded={show === "open"}>
                Open a scoped window
              </button>
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
            <Command cmd="pnpm cli window close">
              Closing sends <span className="mono">MsgCloseEVMWindow</span>, a hybrid tx (ECDSA + your ML-DSA-87 key). No browser wallet can sign
              one on diana yet, so run this in the repo root. It takes effect in the same block.
            </Command>
          ) : null}
          {show === "open" && !open ? (
            <Command cmd="pnpm cli window open">
              Opens 1,800 blocks (~42 min) and 5 txs, scoped to fUSD, fETH, fBTC, your vault and the guardian. Keep it short; close it when you are
              done. Hybrid tx, so it runs from the CLI.
            </Command>
          ) : null}
        </div>
        <div className="window-box">
          <div className="lbl">Your EVM window</div>
          <div className="value" style={{ color: open ? "var(--ink)" : "var(--blue)" }}>
            {!win ? "…" : open ? `Open · ~${Math.max(1, Math.round((Number(win.remainingBlocks) * BLOCK_SECONDS) / 60))} min left` : "Closed"}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
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
              <div className="between" style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
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
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--orange-line)" }}>
          <div className="lbl" style={{ marginBottom: 10 }}>
            Do next
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
            {[
              { t: "Close your EVM window", s: open ? "Stops the leaked key from sending more txs." : "Done. The key can't send anything now.", done: !open && !!win },
              { t: "Stop using this ECDSA key", s: "Move to a new account for future EVM use.", done: false },
              { t: "Recover to a safe address", s: "Sign with Guardian Signer, then submit.", done: false },
            ].map((x) => (
              <div key={x.t} className="check" style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px" }}>
                <span className={`mark ${x.done ? "pass" : ""}`}>{x.done ? "✓" : "•"}</span>
                <div>
                  <div className="ct">{x.t}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{x.s}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Assets({ cfg }: { cfg: AgentConfig }) {
  const assets = usePoll(() => readAssets(cfg), 10_000, `${cfg.owner}/${cfg.vault}`);
  return (
    <section className="card grow">
      <div className="between" style={{ marginBottom: 8 }}>
        <h2>Protected assets</h2>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>EVM lane · vault {shortAddr(cfg.vault)}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ minWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 0 }}>Token</th>
              <th className="num">On your account</th>
              <th className="num">In your vault</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {assets.data ? (
              assets.data.map((a) => {
                const cov = a.allowance === null ? null : coverage(a.allowance);
                return (
                  <tr key={a.sym}>
                    <td style={{ paddingLeft: 0, fontWeight: 600 }}>{a.sym}</td>
                    <td className="num mono">{fmtAmount(a.owner)}</td>
                    <td className="num mono" style={a.vault ? { fontWeight: 600, color: "var(--blue)" } : undefined}>
                      {a.vault === null ? "—" : fmtAmount(a.vault)}
                    </td>
                    <td>{cov ? <span className={`tag ${cov.tone}`}>{cov.text}</span> : <span className="tag">Window budget only</span>}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={4} className="empty">
                  {assets.error ? `Could not read balances: ${assets.error}` : "Reading balances…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--muted)" }}>QOR is not swept. A leaked key can spend it only up to your window's budget.</p>
    </section>
  );
}

function Health({ cfg }: { cfg: AgentConfig }) {
  const { config } = useApp();
  const health = usePoll(fetchHealth, 10_000, "health");
  const rules = usePoll(() => readSpendingRules(cfg.owner), 30_000, cfg.owner);
  const h = config.agentOnline ? health.data : undefined;
  const rule = rules.data ? describeAgentRule(rules.data, cfg.vault) : null;
  const balance = h?.gas.balance != null ? big(h.gas.balance) : null;
  const threshold = h ? big(h.gas.threshold) : 0n;
  const pct = balance !== null && threshold > 0n ? Math.min(100, Number((balance * 100n) / (threshold * 4n))) : 0;
  const channels = h ? Object.entries(h.alerts).filter(([, on]) => on).map(([n]) => (n === "telegram" ? "Telegram" : "Webhook")) : [];

  return (
    <div className="side">
      <section className="card">
        <h2>Guardian health</h2>
        <dl className="kv">
          <div>
            <dt>Agent</dt>
            <dd style={{ color: !h ? "var(--orange)" : h.ok ? "var(--blue)" : "var(--orange)", fontWeight: 600 }}>
              {!h ? "Offline" : `${h.ok ? "Online" : "Degraded"} · block #${h.lastBlock ? fmtInt(h.lastBlock) : "?"}`}
              {h ? <small>last block {ago(h.lastBlockAt)}</small> : null}
            </dd>
          </div>
          <div>
            <dt>Guardian window</dt>
            <dd>
              {!h?.window ? "unknown" : h.window.live ? `${fmtInt(h.window.remainingBlocks)} blocks left` : "closed"}
              {h?.window?.live ? <small>{fmtInt(h.window.remainingTxs)} txs left · the agent renews it</small> : null}
            </dd>
          </div>
          <div>
            <dt>Alerts</dt>
            <dd>{!h ? "—" : channels.length ? `${channels.join(", ")} · on` : "none set"}</dd>
          </div>
          <div>
            <dt>Its permission on your account</dt>
            <dd style={rule && !rule.ok ? { color: "var(--orange)" } : undefined}>
              {rule ? rule.text : rules.error ? "could not read" : "…"}
              <small>{rule?.ok ? "enforced by the chain" : rule ? "not the expected rule" : ""}</small>
            </dd>
          </div>
          <div>
            <dt>Who can withdraw</dt>
            <dd>Only your ML-DSA-87 key</dd>
          </div>
        </dl>
      </section>
      <section className="card">
        <div className="between">
          <h2>Gas tank</h2>
          <span className="mono" style={{ fontSize: 18, fontWeight: 500 }}>
            {balance === null ? "—" : `${fmtAmount(balance)} QOR`}
          </span>
        </div>
        <p style={{ margin: "8px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          The guardian account {h ? <span className="mono">{shortAddr(h.gas.guardian)}</span> : null} pays every rescue tx and its own window.
        </p>
        <div className={`bar ${h?.gas.low ? "low" : ""}`}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="between" style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
          <span>{h ? `You get an alert below ${fmtAmount(threshold)} QOR` : "Agent offline"}</span>
          {h?.gas.low ? <span className="tag orange">Low</span> : null}
        </div>
      </section>
    </div>
  );
}

function ActivityAndTrusted({ cfg }: { cfg: AgentConfig }) {
  const { incidents } = useApp();
  const policy = usePoll(fetchPolicy, 15_000, "policy");
  const activity = usePoll(() => readActivity(cfg), 15_000, `${cfg.owner}/${Object.values(cfg.tokens).join()}`);
  const byHash = new Map(incidents.map((i) => [String(i.trigger?.hash ?? "").toLowerCase(), i]));

  return (
    <div className="row">
      <section className="card grow">
        <h2 style={{ marginBottom: 4 }}>Outgoing activity</h2>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--muted)" }}>
          Every token transfer and approval from your account in the last {fmtInt(ACTIVITY_BLOCKS)} blocks
        </p>
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
                <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
                  <ExtLink href={explorerTx(e.hash)}>#{fmtInt(e.block)}</ExtLink>
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {e.kind === "transfer" ? `Sent ${fmtAmount(e.amount)} ${sym} to ${who.label}` : `Approved ${fmtAmount(e.amount)} ${sym} for ${who.label}`}
                  </div>
                  <div className="wrap-any" style={{ fontSize: 13, color: "var(--muted)" }}>
                    {e.to} · {who.trusted ? "trusted" : "not a trusted address"}
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
          <div className="empty">{activity.error ? `Could not read logs: ${activity.error}` : activity.data ? "Nothing sent from your account in this range." : "Reading logs…"}</div>
        )}
      </section>

      <section className="card side" style={{ gap: 0 }}>
        <div className="between">
          <h2>Trusted wallets and apps</h2>
          <span style={{ fontSize: 13, color: "var(--muted)" }} title="Editing comes in Task 6E">
            Manage <span className="soon" style={{ fontSize: 10 }}>soon</span>
          </span>
        </div>
        <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          A transfer or approval to anything else triggers a rescue. Add a recipient or dApp before you use it.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {policy.data?.trusted.map((t) => (
            <div key={t.address} className="trusted">
              <span style={{ fontWeight: 500 }}>
                {t.label}
                {t.kind === "app" ? <span className="kind">APP</span> : null}
              </span>
              <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }} title={t.address}>
                {shortAddr(t.address)}
              </span>
            </div>
          ))}
          <div className="trusted">
            <span style={{ fontWeight: 500 }}>Your vault</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }} title={cfg.vault}>
              {shortAddr(cfg.vault)}
            </span>
          </div>
          {policy.error ? <div className="empty">Trusted list unavailable: {policy.error}</div> : null}
          {policy.data ? (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              Transfers above {fmtAmount(big(policy.data.maxOutbound))} trigger a rescue even to a trusted wallet.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function Overview() {
  const { config } = useApp();
  const cfg = config.cfg;
  const win = usePoll(() => readWindow(cfg!.owner), 10_000, cfg ? cfg.owner : null);
  if (!cfg) return null;
  return (
    <>
      <Hero cfg={cfg} win={win.data} winError={win.error} />
      <div className="row">
        <Assets cfg={cfg} />
        <Health cfg={cfg} />
      </div>
      <ActivityAndTrusted cfg={cfg} />
      <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>Live data · qorechain-diana testnet</p>
    </>
  );
}
