import type { Incident } from "@qday/core";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { CheckRow, TxHash } from "../components/ui";
import { readReceipt } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { ago, fmtAmount, fmtInt, shortAddr, shortHash, tokenSymbol, when } from "../lib/format";
import { big, incidentTag, triggerKind } from "../lib/incidents";
import type { VerifyResult } from "../lib/verify";
import { useApp } from "../state";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function title(i: Incident, cfg: AgentConfig | null): string {
  const done = i.rescues.filter((r) => r.success);
  if (incidentTag(i) === "Rescue") {
    if (!done.length) return "Rescue attempted, nothing moved";
    const parts = done.map((r) => `${fmtAmount(big(r.amount))} ${tokenSymbol(cfg, r.token)}`);
    return `${parts.join(" + ")} moved to your vault`;
  }
  return triggerKind(i) === "approval" ? "Approval to a spender you don't trust" : "Outgoing transfer flagged";
}

function subtitle(i: Incident, cfg: AgentConfig | null): string {
  const t = i.trigger;
  const sym = tokenSymbol(cfg, t.token);
  return triggerKind(i) === "approval"
    ? `Trigger: approve ${shortAddr(t.to)} for ${fmtAmount(big(t.amount))} ${sym}`
    : `Trigger: ${fmtAmount(big(t.amount))} ${sym} to ${shortAddr(t.to)}`;
}

function VerifyBadge({ v }: { v: VerifyResult | undefined }) {
  if (!v) return <span className="badge">Checking…</span>;
  return v.ok ? (
    <span className="badge ok">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12l5 5 9-10" />
      </svg>
      Report verified
    </span>
  ) : (
    <span className="badge bad">✗ Not verified</span>
  );
}

function download(i: Incident) {
  // Exactly as the agent served it: the signature covers these values, so anyone can re-verify the file.
  const blob = new Blob([`${JSON.stringify(i, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `incident-${i.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Detail({ i, cfg, v }: { i: Incident; cfg: AgentConfig | null; v: VerifyResult | undefined }) {
  const [blocks, setBlocks] = useState<Record<string, bigint | null>>({});
  useEffect(() => {
    let live = true;
    const hashes = i.rescues.filter((r) => r.success && HASH_RE.test(r.hash)).map((r) => r.hash as Hex);
    void Promise.all(hashes.map(async (h) => [h, await readReceipt(h).then((r) => r?.blockNumber ?? null, () => null)] as const)).then((pairs) => {
      if (live) setBlocks(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [i]);

  const t = i.trigger;
  const kind = triggerKind(i);
  const sym = tokenSymbol(cfg, t.token);
  const done = i.rescues.filter((r) => r.success);
  const triggerBlock = big(t.block);
  const rescueBlocks = Object.values(blocks).filter((b): b is bigint => b !== null);
  const lastRescue = rescueBlocks.length ? rescueBlocks.reduce((a, b) => (b > a ? b : a)) : null;
  const keptSame = done.filter((r) => r.token.toLowerCase() === t.token.toLowerCase()).reduce((s, r) => s + big(r.amount), 0n);
  const lost = kind === "transfer" ? big(t.amount) : 0n;
  const pct = kind === "transfer" && keptSame + lost > 0n ? Number((keptSame * 1000n) / (keptSame + lost)) / 10 : null;

  const stats = [
    { k: "Drain → rescue", v: !done.length ? "—" : lastRescue === null ? "…" : `${fmtInt(lastRescue - triggerBlock)} block${lastRescue - triggerBlock === 1n ? "" : "s"}` },
    { k: `Value kept (${sym})`, v: pct === null || !done.length ? "—" : `${pct}%` },
    { k: kind === "approval" ? "Spender got" : "Attacker got", v: kind === "approval" ? "an allowance" : `${fmtAmount(lost)} ${sym}` },
    { k: "Rescue txs", v: i.rescues.length ? `${done.length} of ${i.rescues.length} ok` : "none (alert)" },
  ];

  return (
    <div className="stack" style={{ flex: "999 1 600px", minWidth: 0 }}>
      <section className="card" style={{ padding: 24 }}>
        <div className="between" style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div className="mono wrap-any" style={{ fontSize: 13, color: "var(--muted)" }}>
              Incident {i.id}
            </div>
            <h2 className="h" style={{ margin: "6px 0 0", fontSize: 24 }}>
              {title(i, cfg)}
            </h2>
          </div>
          <VerifyBadge v={v} />
        </div>

        <div className="stats">
          {stats.map((s) => (
            <div key={s.k} className="stat">
              <div className="k">{s.k}</div>
              <div className="v">{s.v}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="lbl" style={{ marginBottom: 8 }}>
            Summary · {i.summarySource === "llm" ? "written by AI" : "template"}
          </div>
          <p className="wrap-any" style={{ margin: 0, fontSize: 15, lineHeight: 1.65 }}>
            {i.summary}
          </p>
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="lbl" style={{ marginBottom: 4 }}>
            Timeline
          </div>
          <div className="tl">
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)", paddingTop: 2 }}>
              #{fmtInt(String(t.block))}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="who attacker">Your ECDSA key</span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {kind === "approval" ? `Approved ${shortAddr(t.to)} for ${fmtAmount(big(t.amount))} ${sym}` : `Sent ${fmtAmount(big(t.amount))} ${sym} to ${shortAddr(t.to)}`}
                </span>
              </div>
              <div className="wrap-any" style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
                tx <TxHash hash={t.hash} />
              </div>
            </div>
          </div>
          <div className="tl">
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)", paddingTop: 2 }}>
              {when(i.detectedAt)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="who guardian">Guardian</span>
                <span className="wrap-any" style={{ fontSize: 14, fontWeight: 600 }}>
                  Rule matched: {i.reason}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>Decided by fixed rules, not by AI</div>
            </div>
          </div>
          {i.rescues.map((r, n) => (
            <div key={`${r.hash}/${r.token}/${n}`} className="tl">
              <span className="mono" style={{ fontSize: 12, color: "var(--muted)", paddingTop: 2 }}>
                {blocks[r.hash] ? `#${fmtInt(blocks[r.hash]!)}` : "—"}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="who guardian">Guardian</span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    {r.success
                      ? `vault.rescue(${tokenSymbol(cfg, r.token)}): ${fmtAmount(big(r.amount))} ${tokenSymbol(cfg, r.token)} into your vault`
                      : `vault.rescue(${tokenSymbol(cfg, r.token)}) failed`}
                  </span>
                </div>
                <div className="wrap-any" style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
                  {HASH_RE.test(r.hash) ? (
                    <>
                      tx <TxHash hash={r.hash} />
                    </>
                  ) : r.hash ? (
                    `tx ${shortHash(r.hash)}`
                  ) : null}
                  {r.error ? ` · ${r.error}` : null}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="actions">
          {done.length ? (
            <a className="btn primary" href="#/recover">
              Recover funds
            </a>
          ) : null}
          <button type="button" className="btn" onClick={() => download(i)}>
            Download signed report
          </button>
        </div>
      </section>

      <section className="card">
        <h3 className="h" style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600 }}>
          Why you can trust this report
        </h3>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--muted)" }}>
          Checked in your browser against the chain, not taken from the agent's word{cfg ? ` (owner ${shortAddr(cfg.owner)})` : ""}
        </p>
        <div className="checks">
          {v ? v.checks.map((c) => <CheckRow key={c.id} status={c.status} title={c.title} detail={c.detail} />) : <CheckRow status="pending" title="Checking against the chain…" />}
        </div>
      </section>
    </div>
  );
}

export function Incidents({ selected }: { selected?: string }) {
  const { incidents, incidentsError, verdictFor, config } = useApp();
  const cfg = config.cfg;
  const current = incidents.find((i) => i.id === selected) ?? incidents[0];

  return (
    <>
      <h1>Incidents</h1>
      <p className="lead">Every rescue and alert the Guardian raised, with a report it signed. Fixed rules decide; AI only writes the summary.</p>
      {incidentsError && !incidents.length ? <div className="banner warn">Could not load incidents from the agent: {incidentsError}</div> : null}
      {!incidents.length && !incidentsError ? <div className="empty">No incidents yet. New ones appear here live.</div> : null}
      {incidents.length ? (
        <div className="row">
          <section aria-label="Incident list" className="inc-list">
            {incidents.map((i) => {
              const tag = incidentTag(i);
              const v = verdictFor(i);
              return (
                <a key={i.id} className="inc-item" href={`#/incidents/${encodeURIComponent(i.id)}`} aria-current={i === current ? "true" : undefined}>
                  <span className="between" style={{ alignItems: "center" }}>
                    <span className={`tag ${tag === "Rescue" ? "orange" : ""}`}>{tag}</span>
                    <span style={{ fontSize: 12, color: "var(--muted)" }} title={i.detectedAt}>
                      {ago(i.detectedAt)} {v ? (v.ok ? <span style={{ color: "var(--blue)" }}>✓</span> : <span style={{ color: "var(--red)" }}>✗</span>) : "…"}
                    </span>
                  </span>
                  <span className="t">{title(i, cfg)}</span>
                  <span className="s">{subtitle(i, cfg)}</span>
                </a>
              );
            })}
          </section>
          {current ? <Detail key={current.id} i={current} cfg={cfg} v={verdictFor(current)} /> : null}
        </div>
      ) : null}
    </>
  );
}
